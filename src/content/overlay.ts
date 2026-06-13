import { lastCueIndexBefore } from '../core/cues'
import type { Settings } from '../shared/settings'
import type { Cue } from '../shared/types'

/**
 * Bilingual caption overlay bound to one <video>. The source line is the
 * anchor; the translated line appears underneath as soon as its batch lands.
 * Rendering is rAF-driven while playing. Honors display mode (bilingual /
 * source / target) and placement (over the video, or docked below it).
 */
export class CaptionOverlay {
  /** Shared hidden node for measuring REAL line wrapping (respects word breaks,
   *  unlike a canvas one-line measure). Lazily created, one per document. */
  private static measureEl: HTMLSpanElement | null = null

  private root: HTMLDivElement
  private srcEl: HTMLDivElement
  private tgtEl: HTMLDivElement
  private srcSpan: HTMLSpanElement
  private tgtSpan: HTMLSpanElement
  private cues: Cue[] = []
  private lastIndex = -2
  private raf = 0
  private visible = true
  private disposed = false
  private containerWidth = 600
  private resizeObserver: ResizeObserver | null = null

  constructor(
    private video: HTMLVideoElement,
    private container: HTMLElement,
    private display: Settings['display'],
  ) {
    this.root = document.createElement('div')
    this.root.className = 'acap-overlay'
    // Each line is a centered block row; the inner span carries the background
    // so it hugs each wrapped visual line (box-decoration-break: clone) rather
    // than one wide box behind balanced text.
    this.srcEl = document.createElement('div')
    this.srcEl.className = 'acap-line acap-line-src'
    this.srcSpan = document.createElement('span')
    this.srcSpan.className = 'acap-text'
    this.srcEl.appendChild(this.srcSpan)
    this.tgtEl = document.createElement('div')
    this.tgtEl.className = 'acap-line acap-line-tgt'
    this.tgtSpan = document.createElement('span')
    this.tgtSpan.className = 'acap-text'
    this.tgtEl.appendChild(this.tgtSpan)
    this.container.appendChild(this.root)
    this.applyDisplay(display)

    this.video.addEventListener('timeupdate', this.onTick)
    this.video.addEventListener('seeked', this.onTick)
    this.video.addEventListener('play', this.startLoop)
    this.video.addEventListener('pause', this.stopLoop)
    if (!video.paused) this.startLoop()
    this.observeResize()
  }

  setCues(cues: Cue[]): void {
    this.cues = cues
    this.lastIndex = -2
    this.onTick()
  }

  patch(ids: number[], texts: string[]): void {
    for (let i = 0; i < ids.length; i++) {
      const cue = this.cues[ids[i]!]
      if (cue) cue.tgt = texts[i]!
    }
    this.lastIndex = -2
    this.onTick()
  }

  setVisible(v: boolean): void {
    this.visible = v
    this.root.style.display = v ? '' : 'none'
    if (v) {
      this.lastIndex = -2
      this.onTick()
    }
  }

  applyDisplay(display: Settings['display']): void {
    this.display = display
    this.root.style.setProperty('--acap-bg-alpha', String(display.bgOpacity))
    this.root.style.setProperty('--acap-src-scale', String(display.srcScale))
    this.root.style.setProperty('--acap-tgt-scale', String(display.tgtScale))
    if (!this.root.isConnected) this.container.appendChild(this.root)

    // Line order + which lines participate (mode).
    const order = display.srcFirst ? [this.srcEl, this.tgtEl] : [this.tgtEl, this.srcEl]
    this.root.replaceChildren(...order)
    this.lastIndex = -2
    this.onTick()
  }

  dispose(): void {
    this.disposed = true
    this.stopLoop()
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.video.removeEventListener('timeupdate', this.onTick)
    this.video.removeEventListener('seeked', this.onTick)
    this.video.removeEventListener('play', this.startLoop)
    this.video.removeEventListener('pause', this.stopLoop)
    this.root.remove()
  }

  private startLoop = (): void => {
    this.stopLoop()
    const loop = (): void => {
      if (this.disposed || this.video.paused) return
      this.onTick()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  private stopLoop = (): void => {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
  }

  private onTick = (): void => {
    if (!this.visible || this.cues.length === 0) return
    // Hold each line until the next cue begins (not just until the source
    // sentence stopped). The translation is often longer than the spoken
    // original, so the silence between sentences is reading time — this is the
    // single biggest lever for "I couldn't finish reading before it changed".
    const idx = lastCueIndexBefore(this.cues, this.video.currentTime)
    if (idx === this.lastIndex) return
    this.lastIndex = idx
    if (idx === -1) {
      this.render('', '')
      return
    }
    const cue = this.cues[idx]!
    this.render(cue.src, cue.tgt ?? '')
  }

  private render(src: string, tgt: string): void {
    const mode = this.display.mode
    // source-only and target-only collapse to a single line; target falls back
    // to the original when its translation hasn't landed yet.
    const showSrc = mode !== 'target'
    const showTgt = mode !== 'source'
    this.srcSpan.textContent = showSrc ? src : ''
    this.tgtSpan.textContent = showTgt ? (mode === 'target' ? tgt || src : tgt) : ''
    this.srcEl.style.display = this.srcSpan.textContent ? '' : 'none'
    this.tgtEl.style.display = this.tgtSpan.textContent ? '' : 'none'
    const any = Boolean(this.srcSpan.textContent || this.tgtSpan.textContent)
    this.root.classList.toggle('acap-overlay-active', any)
    if (this.srcSpan.textContent) this.fitBox(this.srcSpan)
    if (this.tgtSpan.textContent) this.fitBox(this.tgtSpan)
  }

  /**
   * Size one caption box to hug its text:
   *  - fits on one line within the player → keep one line (box = text width);
   *  - otherwise find the SMALLEST width that still wraps into the fewest lines,
   *    so the box hugs the text (no wide empty margins) and `text-wrap: balance`
   *    (in CSS) evens the lines (no long-then-short orphan).
   * Wrapping is measured on a hidden node at real widths, so it respects actual
   * word boundaries rather than estimating from a single-line width.
   */
  private fitBox(span: HTMLSpanElement): void {
    const text = span.textContent ?? ''
    if (!text) return
    const m = CaptionOverlay.getMeasureEl(span)
    m.textContent = text

    const padH = 22 // .acap-text horizontal padding (≈ 2 × 11px), added outside the content width
    const availContent = Math.max(40, this.containerWidth * 0.92 - padH)
    span.style.maxWidth = `${Math.round(availContent + padH)}px`

    m.style.whiteSpace = 'nowrap'
    m.style.width = 'auto'
    const oneLine = m.offsetWidth
    const lineH = m.offsetHeight
    m.style.whiteSpace = 'pre-wrap'
    if (lineH === 0 || oneLine <= availContent) {
      span.style.width = 'auto' // one line — hug it
      return
    }

    const targetLines = Math.ceil(oneLine / availContent)
    let lo = Math.ceil(oneLine / targetLines)
    let hi = Math.round(availContent)
    let best = hi
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      m.style.width = `${mid}px`
      const lines = Math.round(m.offsetHeight / lineH)
      if (lines <= targetLines) {
        best = mid
        hi = mid - 1
      } else {
        lo = mid + 1
      }
    }
    span.style.width = `${best}px` // content width; CSS padding + balance do the rest
  }

  /** Hidden measurer that mirrors `span`'s font so wrapping matches the render. */
  private static getMeasureEl(span: HTMLSpanElement): HTMLSpanElement {
    let m = CaptionOverlay.measureEl
    if (!m) {
      m = document.createElement('span')
      m.setAttribute('aria-hidden', 'true')
      m.style.cssText =
        'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;margin:0;border:0;padding:0;white-space:pre-wrap;'
      document.body.appendChild(m)
      CaptionOverlay.measureEl = m
    }
    const cs = getComputedStyle(span)
    m.style.fontFamily = cs.fontFamily
    m.style.fontSize = cs.fontSize
    m.style.fontWeight = cs.fontWeight
    m.style.letterSpacing = cs.letterSpacing
    m.style.lineHeight = cs.lineHeight
    m.style.wordBreak = cs.wordBreak
    return m
  }

  private observeResize(): void {
    const apply = (w: number): void => {
      this.containerWidth = w
      const base = Math.min(22, Math.max(12, w * 0.028))
      this.root.style.setProperty('--acap-font-base', `${base}px`)
      // Box width is measured per render, so re-fit the on-screen line for the
      // new player size (entering/leaving fullscreen keeps the same cue, which
      // onTick would otherwise skip).
      this.lastIndex = -2
      this.onTick()
    }
    apply(this.container.clientWidth || 600)
    this.resizeObserver = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) apply(w)
    })
    this.resizeObserver.observe(this.container)
  }
}
