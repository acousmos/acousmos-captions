import { findCueIndex } from '../core/cues'
import type { Settings } from '../shared/settings'
import type { Cue } from '../shared/types'

/**
 * Bilingual caption overlay bound to one <video>. The source line is the
 * anchor (always rendered); the translated line appears underneath as soon as
 * its batch lands. Rendering is rAF-driven while playing.
 */
export class CaptionOverlay {
  private root: HTMLDivElement
  private srcEl: HTMLDivElement
  private tgtEl: HTMLDivElement
  private cues: Cue[] = []
  private lastIndex = -2
  private raf = 0
  private visible = true
  private disposed = false

  constructor(
    private video: HTMLVideoElement,
    container: HTMLElement,
    private display: Settings['display'],
  ) {
    this.root = document.createElement('div')
    this.root.className = 'acap-overlay'
    this.srcEl = document.createElement('div')
    this.srcEl.className = 'acap-line acap-line-src'
    this.tgtEl = document.createElement('div')
    this.tgtEl.className = 'acap-line acap-line-tgt'
    this.applyDisplay(display)
    container.appendChild(this.root)

    this.video.addEventListener('timeupdate', this.onTick)
    this.video.addEventListener('seeked', this.onTick)
    this.video.addEventListener('play', this.startLoop)
    this.video.addEventListener('pause', this.stopLoop)
    if (!video.paused) this.startLoop()
    this.observeResize(container)
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
    this.root.replaceChildren(...(display.srcFirst ? [this.srcEl, this.tgtEl] : [this.tgtEl, this.srcEl]))
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
    const idx = findCueIndex(this.cues, this.video.currentTime)
    if (idx === this.lastIndex) return
    this.lastIndex = idx
    if (idx === -1) {
      this.srcEl.textContent = ''
      this.tgtEl.textContent = ''
      this.root.classList.remove('acap-overlay-active')
      return
    }
    const cue = this.cues[idx]!
    this.srcEl.textContent = cue.src
    this.tgtEl.textContent = cue.tgt ?? ''
    this.tgtEl.style.display = cue.tgt ? '' : 'none'
    this.root.classList.add('acap-overlay-active')
  }

  private observeResize(container: HTMLElement): void {
    const apply = (w: number): void => {
      // Base size tracks player width; user scale multiplies on top.
      const base = Math.min(26, Math.max(13, w * 0.032))
      this.root.style.setProperty('--acap-font-base', `${base}px`)
    }
    apply(container.clientWidth || 600)
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) apply(w)
    })
    ro.observe(container)
  }
}
