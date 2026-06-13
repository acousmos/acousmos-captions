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
   * Size one caption box so its background hugs the TEXT, not the layout width:
   *  - one line → keep `width: auto` (inline-block already hugs);
   *  - multiple lines → measure the real wrapped lines (with `text-wrap: balance`
   *    already applied via CSS) and shrink the box to the longest actual line.
   * Measuring the rendered span directly (Range line rects) is the only way to get
   * the post-balance line widths; shrinking re-runs balance, so we measure again
   * once so the final width matches the final longest line (no wide side margins,
   * no per-line bars — still one box per language).
   */
  private fitBox(span: HTMLSpanElement): void {
    if (!span.textContent) return
    span.style.maxWidth = `${Math.max(80, Math.round(this.containerWidth * 0.92))}px`
    span.style.width = 'auto'
    for (let pass = 0; pass < 2; pass++) {
      const widths = this.lineWidths(span)
      if (widths.length <= 1) {
        span.style.width = 'auto' // single line — already hugs
        return
      }
      span.style.width = `${Math.ceil(Math.max(...widths))}px`
    }
  }

  /** Width of each rendered line of `span`'s text (groups client rects by row, so
   *  a mixed CJK/Latin line counts once at its full extent). */
  private lineWidths(span: HTMLSpanElement): number[] {
    if (!span.firstChild) return []
    const range = document.createRange()
    range.selectNodeContents(span)
    const rows = new Map<number, { left: number; right: number }>()
    for (const r of range.getClientRects()) {
      if (r.width === 0) continue
      const key = Math.round(r.top)
      const row = rows.get(key)
      if (row) {
        row.left = Math.min(row.left, r.left)
        row.right = Math.max(row.right, r.right)
      } else {
        rows.set(key, { left: r.left, right: r.right })
      }
    }
    return [...rows.values()].map((r) => r.right - r.left)
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
