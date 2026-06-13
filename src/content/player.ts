import { mediaIdFromPoster } from '../core/mediaid'
import { JOB_PORT_PREFIX, type JobEvent, type JobRequest } from '../shared/messages'
import { loadSettings, saveSettings, type Settings } from '../shared/settings'
import { t } from '../shared/i18n'
import type { Cue, Utterance } from '../shared/types'
import { downloadSrt } from './exporter'
import { getNativeUtterances } from './nativeTrack'
import { CaptionOverlay } from './overlay'
import { toast } from './toast'

type State = 'idle' | 'working' | 'live' | 'error'

/** Controller for one X video player: pill button, menu, job port, overlay. */
export class PlayerController {
  private root: HTMLDivElement
  private pill: HTMLButtonElement
  private menu: HTMLDivElement | null = null
  private menuCloseHandler: ((e: MouseEvent) => void) | null = null
  private overlay: CaptionOverlay | null = null
  private port: chrome.runtime.Port | null = null
  private state: State = 'idle'
  private cues: Cue[] = []
  private mediaId: string
  private captionsOn = true
  private nudged = false
  private readyNotified = false
  private disposed = false
  private enabled = true
  private repositionScheduled = false
  private rootResizeObserver: ResizeObserver | null = null

  constructor(
    private video: HTMLVideoElement,
    private container: HTMLElement,
    private settings: Settings,
    mediaId: string,
  ) {
    this.mediaId = mediaId
    this.root = document.createElement('div')
    this.root.className = 'acap-root'
    this.pill = document.createElement('button')
    this.pill.className = 'acap-pill'
    this.pill.type = 'button'
    this.setPill('pill_idle', 'idle')
    this.pill.addEventListener('click', (e) => {
      e.stopPropagation()
      e.preventDefault()
      this.onPillClick()
    })
    this.root.appendChild(this.pill)
    // Mount the interactive UI at document level, not inside the player: X wraps
    // the player in z-index:0 stacking contexts and overlays a transparent
    // click-catcher on top, so a pill inside the player can't receive clicks no
    // matter its z-index. A fixed, body-level root sits above all of it; we keep
    // it pinned to the player's top-right and reparent into the fullscreen
    // element while fullscreen.
    document.body.appendChild(this.root)
    this.positionRoot()
    window.addEventListener('scroll', this.reposition, { passive: true, capture: true })
    window.addEventListener('resize', this.reposition, { passive: true })
    document.addEventListener('fullscreenchange', this.onFullscreenChange)
    this.rootResizeObserver = new ResizeObserver(this.reposition)
    this.rootResizeObserver.observe(this.container)
  }

  static mediaIdFor(video: HTMLVideoElement): { id: string } | 'gif' | null {
    const info = mediaIdFromPoster(video.poster ?? '')
    if (!info) return null
    if (info.kind === 'gif') return 'gif'
    return { id: info.id }
  }

  updateSettings(s: Settings): void {
    this.settings = s
    this.overlay?.applyDisplay(s.display)
  }

  /** Master on/off from the popup: hide the pill and overlay when off. */
  setEnabled(on: boolean): void {
    this.enabled = on
    this.positionRoot()
    if (this.overlay) this.overlay.setVisible(on && this.captionsOn)
  }

  /** Pin the body-level pill to the player's top-right; hide if off-screen. */
  private positionRoot(): void {
    const r = this.container.getBoundingClientRect()
    const offscreen =
      !this.container.isConnected || r.width === 0 || r.bottom < 0 || r.top > window.innerHeight
    if (!this.enabled || offscreen) {
      this.root.style.display = 'none'
      return
    }
    this.root.style.display = ''
    this.root.style.top = `${Math.round(r.top + 8)}px`
    this.root.style.right = `${Math.round(window.innerWidth - r.right + 8)}px`
    this.root.style.left = 'auto'
  }

  private reposition = (): void => {
    if (this.repositionScheduled) return
    this.repositionScheduled = true
    requestAnimationFrame(() => {
      this.repositionScheduled = false
      if (!this.disposed) this.positionRoot()
      if (this.menu) this.positionMenu(this.menu)
    })
  }

  private onFullscreenChange = (): void => {
    // Fullscreen renders only the fullscreen element's subtree, so move our
    // root inside it; otherwise keep it at body level.
    const fs = document.fullscreenElement
    if (fs && fs.contains(this.container)) fs.appendChild(this.root)
    else document.body.appendChild(this.root)
    this.reposition()
  }

  dispose(): void {
    this.disposed = true
    window.removeEventListener('scroll', this.reposition, { capture: true } as EventListenerOptions)
    window.removeEventListener('resize', this.reposition)
    document.removeEventListener('fullscreenchange', this.onFullscreenChange)
    this.rootResizeObserver?.disconnect()
    this.port?.disconnect()
    this.overlay?.dispose()
    this.menu?.remove()
    this.root.remove()
  }

  get videoEl(): HTMLVideoElement {
    return this.video
  }

  private onPillClick(): void {
    if (this.state === 'live') {
      this.toggleMenu()
      return
    }
    if (this.state === 'working') return
    this.start(false)
  }

  private start(force: boolean, forceAsr = false): void {
    // Neutral label until the background reports a phase — the source (native
    // captions vs ASR) isn't known yet, so don't claim "fetching audio".
    this.setPill('pill_working', 'working')
    this.closeMenu()
    this.port?.disconnect()
    void this.beginJob(force, forceAsr)
  }

  private async beginJob(force: boolean, forceAsr: boolean): Promise<void> {
    // Reuse the video's own subtitle track when it has one — accurate, free,
    // already timed — and only fall back to ASR otherwise. forceAsr skips this
    // (menu escape hatch for when the native captions are poor).
    let nativeUtterances: Utterance[] | undefined
    if (!forceAsr) {
      try {
        nativeUtterances = (await getNativeUtterances(this.video, this.settings.asr.sourceLang)) ?? undefined
      } catch {
        // ignore — fall back to ASR
      }
    }
    if (this.disposed) return
    const port = chrome.runtime.connect({ name: `${JOB_PORT_PREFIX}${this.mediaId}` })
    this.port = port
    port.onMessage.addListener((ev: JobEvent) => this.onEvent(ev))
    port.onDisconnect.addListener(() => {
      if (this.port === port) this.port = null
      if (!this.disposed && this.state === 'working') this.setPill('pill_error', 'error')
    })
    const req: JobRequest = {
      kind: 'job/start',
      mediaId: this.mediaId,
      force,
      pageUrl: location.href,
      nativeUtterances,
    }
    port.postMessage(req)
  }

  private onEvent(ev: JobEvent): void {
    if (this.disposed) return
    switch (ev.kind) {
      case 'job/debug': {
        console.debug('[acousmos-captions]', ev.info)
        break
      }
      case 'job/progress': {
        if (ev.progress.errorKey) {
          toast(t(ev.progress.errorKey))
        } else if (ev.progress.ratio !== undefined && this.cues.length > 0 && ev.progress.ratio < 1) {
          // Captions are already showing; the rest of a long video streams in.
          this.setPillRaw(`${t('pill_idle')} ${Math.round(ev.progress.ratio * 100)}%`, 'live')
        } else if (this.cues.length === 0) {
          if (ev.progress.phase === 'fetching_audio') this.setPill('pill_capturing', 'working')
          else if (ev.progress.phase === 'transcribing') this.setPill('pill_transcribing', 'working')
          else if (ev.progress.phase === 'translating') this.setPill('pill_translating', 'working')
        }
        break
      }
      case 'job/utterances': {
        this.cues = ev.cues
        this.ensureOverlay().setCues(this.cues)
        // Captions are on screen but more may still be processing; the
        // percentage from job/progress takes over until job/done.
        this.setPillRaw(t('pill_idle'), 'live')
        this.notifyReady()
        break
      }
      case 'job/translated': {
        this.overlay?.patch(ev.ids, ev.texts)
        break
      }
      case 'job/done': {
        this.cues = ev.result.cues
        this.ensureOverlay().setCues(this.cues)
        this.setPill('pill_on', 'live')
        // Cached results skip the utterances event, so notify here too.
        this.notifyReady()
        break
      }
      case 'job/error': {
        this.onError(ev.errorKey, ev.detail)
        break
      }
    }
  }

  private onError(key: string, detail?: string): void {
    if (key === 'toast_need_play' && !this.nudged) {
      // The player hasn't requested its stream yet; nudge a muted play to
      // trigger it, then retry once.
      this.nudged = true
      void this.nudgePlayback().then(() => this.start(false))
      return
    }
    this.setPill('pill_error', 'error')
    toast(t(key))
    if (detail) console.warn('[acousmos-captions]', key, detail)
    setTimeout(() => {
      if (this.state === 'error') this.setPill('pill_idle', 'idle')
    }, 2500)
  }

  private async nudgePlayback(): Promise<void> {
    const v = this.video
    const wasPaused = v.paused
    const wasMuted = v.muted
    try {
      v.muted = true
      await v.play()
      await new Promise((r) => setTimeout(r, 1500))
      if (wasPaused) v.pause()
    } catch {
      // autoplay refused — user will need to press play themselves
      toast(t('toast_need_play'))
    } finally {
      v.muted = wasMuted
    }
  }

  /** Tell the user, once, that captions are live and where they show up. */
  private notifyReady(): void {
    if (this.readyNotified) return
    this.readyNotified = true
    if (this.video.paused) toast(t('toast_ready'), 4000)
  }

  private ensureOverlay(): CaptionOverlay {
    if (!this.overlay) {
      this.overlay = new CaptionOverlay(this.video, this.container, this.settings.display)
      this.overlay.setVisible(this.captionsOn)
    }
    return this.overlay
  }

  private setPill(labelKey: string, state: State): void {
    this.setPillRaw(t(labelKey), state)
  }

  private setPillRaw(text: string, state: State): void {
    this.state = state
    this.pill.textContent = text
    this.pill.dataset['state'] = state
  }

  // --- menu ---

  private toggleMenu(): void {
    if (this.menu) {
      this.closeMenu()
      return
    }
    const menu = document.createElement('div')
    menu.className = 'acap-menu'
    const lang = this.settings.llm.targetLang

    // Quick caption-mode switch (persisted) — the frequently-changed control
    // belongs here, not buried in Settings.
    const mode = this.settings.display.mode
    menu.appendChild(this.menuRadio(t('opt_mode_bilingual'), mode === 'bilingual', () => this.setMode('bilingual')))
    menu.appendChild(this.menuRadio(t('opt_mode_source'), mode === 'source', () => this.setMode('source')))
    menu.appendChild(this.menuRadio(t('opt_mode_target'), mode === 'target', () => this.setMode('target')))
    menu.appendChild(this.menuSep())

    menu.appendChild(
      this.menuItem(this.captionsOn ? t('menu_hide') : t('menu_show'), () => {
        this.captionsOn = !this.captionsOn
        this.overlay?.setVisible(this.captionsOn)
      }),
    )
    menu.appendChild(this.menuItem(t('menu_export_bilingual'), () => downloadSrt(this.cues, 'bilingual', this.mediaId, lang)))
    menu.appendChild(this.menuItem(t('menu_export_source'), () => downloadSrt(this.cues, 'source', this.mediaId, lang)))
    menu.appendChild(this.menuItem(t('menu_export_target'), () => downloadSrt(this.cues, 'target', this.mediaId, lang)))
    menu.appendChild(this.menuSep())
    menu.appendChild(this.menuItem(t('menu_retranslate'), () => this.start(true)))
    // Escape hatch when the video's own captions are poor: force ASR.
    menu.appendChild(this.menuItem(t('menu_force_asr'), () => this.start(true, true)))
    menu.appendChild(
      this.menuItem(t('menu_settings'), () => {
        void chrome.runtime.sendMessage({ kind: 'options/open' }).catch(() => undefined)
      }),
    )

    this.root.appendChild(menu)
    this.menu = menu
    this.positionMenu(menu)
    // Close on any click outside the menu. If that click is on our own pill,
    // swallow it so onPillClick doesn't immediately reopen — second click on
    // the pill toggles the menu shut.
    this.menuCloseHandler = (e: MouseEvent): void => {
      if (menu.contains(e.target as Node)) return
      this.closeMenu()
      if (this.root.contains(e.target as Node)) {
        e.stopPropagation()
        e.preventDefault()
      }
    }
    setTimeout(() => {
      if (this.menuCloseHandler) document.addEventListener('click', this.menuCloseHandler, true)
    }, 0)
  }

  /** Change caption mode, apply to this overlay immediately, and persist. */
  private setMode(mode: Settings['display']['mode']): void {
    this.settings = { ...this.settings, display: { ...this.settings.display, mode } }
    this.overlay?.applyDisplay(this.settings.display)
    void loadSettings().then((s) => {
      s.display.mode = mode
      return saveSettings(s)
    })
  }

  private menuRadio(label: string, active: boolean, fn: () => void): HTMLButtonElement {
    const b = this.menuItem(`${active ? '✓ ' : ' '}${label}`, fn)
    if (active) b.classList.add('acap-menu-active')
    return b
  }

  /** Anchor the fixed menu under the pill, flipping up / clamping to stay on screen. */
  private positionMenu(menu: HTMLDivElement): void {
    const r = this.pill.getBoundingClientRect()
    const mw = menu.offsetWidth || 220
    const mh = menu.offsetHeight || 240
    const margin = 8
    let top = r.bottom + 6
    if (top + mh > window.innerHeight - margin) {
      // Not enough room below — prefer above the pill, else clamp.
      top = Math.max(margin, Math.min(r.top - 6 - mh, window.innerHeight - margin - mh))
    }
    const left = Math.max(margin, Math.min(r.right - mw, window.innerWidth - margin - mw))
    menu.style.top = `${Math.round(top)}px`
    menu.style.left = `${Math.round(left)}px`
  }

  private menuSep(): HTMLDivElement {
    const d = document.createElement('div')
    d.className = 'acap-menu-sep'
    return d
  }

  private menuItem(label: string, fn: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'acap-menu-item'
    b.textContent = label
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      e.preventDefault()
      this.closeMenu()
      fn()
    })
    return b
  }

  private closeMenu(): void {
    if (this.menuCloseHandler) {
      document.removeEventListener('click', this.menuCloseHandler, true)
      this.menuCloseHandler = null
    }
    this.menu?.remove()
    this.menu = null
  }
}
