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
  private cues: Cue[] = []
  private lastIndex = -2
  private raf = 0
  private visible = true
  private isBelow = false
  private disposed = false
  private containerWidth = 600

  constructor(
    private video: HTMLVideoElement,
    private container: HTMLElement,
    private display: Settings['display'],
  ) {
    this.root = document.createElement('div')
    this.root.className = 'acap-overlay'
    this.srcEl = document.createElement('div')
    this.srcEl.className = 'acap-line acap-line-src'
    this.tgtEl = document.createElement('div')
    this.tgtEl.className = 'acap-line acap-line-tgt'
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
    this.root.style.setProperty('--acap-font-scale', String(display.fontScale))

    // Re-mount if placement changed: 'overlay' sits absolutely inside the
    // player; 'below' is a normal-flow block directly under it.
    const below = display.placement === 'below'
    if (below !== this.isBelow || !this.root.isConnected) {
      this.isBelow = below
      this.root.classList.toggle('acap-overlay-below', below)
      if (below) this.container.insertAdjacentElement('afterend', this.root)
      else this.container.appendChild(this.root)
    }

    // Line order + which lines participate (mode).
    const order = display.srcFirst ? [this.srcEl, this.tgtEl] : [this.tgtEl, this.srcEl]
    this.root.replaceChildren(...order)
    this.lastIndex = -2
    this.onTick()
  }

  dispose(): void {
    this.disposed = true
    this.stopLoop()
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
    this.srcEl.textContent = showSrc ? src : ''
    this.tgtEl.textContent = showTgt ? (mode === 'target' ? tgt || src : tgt) : ''
    this.srcEl.style.display = this.srcEl.textContent ? '' : 'none'
    this.tgtEl.style.display = this.tgtEl.textContent ? '' : 'none'
    const any = Boolean(this.srcEl.textContent || this.tgtEl.textContent)
    this.root.classList.toggle('acap-overlay-active', any)
    this.applyFit(this.srcEl.textContent ?? '', this.tgtEl.textContent ?? '')
  }

  /**
   * Auto-shrink long lines so they don't crowd a small player (the "automatic
   * smaller font" the user asked for). Estimates how many lines each side would
   * wrap to at full size and scales down toward a floor so the block stays ~2
   * lines per language — never touches cue text, only display size.
   */
  private applyFit(src: string, tgt: string): void {
    const basePx =
      parseFloat(getComputedStyle(this.root).getPropertyValue('--acap-font-base')) || 16
    const unitsPerLine = Math.max(8, this.containerWidth / (basePx * this.display.fontScale))
    // CJK glyphs are ~1 unit wide, Latin ~0.55.
    const lineUnits = (s: string): number => {
      let u = 0
      for (const c of s) u += /[⺀-鿿＀-￯　-〿]/.test(c) ? 1 : 0.55
      return u
    }
    const worstLines = Math.max(lineUnits(src) * 0.82, lineUnits(tgt)) / unitsPerLine
    const fit = worstLines > 2 ? Math.max(0.7, 2 / worstLines) : 1
    this.root.style.setProperty('--acap-fit-scale', fit.toFixed(3))
  }

  private observeResize(): void {
    const apply = (w: number): void => {
      this.containerWidth = w
      const base = Math.min(22, Math.max(12, w * 0.028))
      this.root.style.setProperty('--acap-font-base', `${base}px`)
    }
    apply(this.container.clientWidth || 600)
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) apply(w)
    })
    ro.observe(this.container)
  }
}
