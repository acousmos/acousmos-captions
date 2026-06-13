import { mediaIdFromPoster } from '../core/mediaid'
import { JOB_PORT_PREFIX, type JobEvent, type JobRequest } from '../shared/messages'
import type { Settings } from '../shared/settings'
import { t } from '../shared/i18n'
import type { Cue } from '../shared/types'
import { downloadSrt } from './exporter'
import { CaptionOverlay } from './overlay'
import { toast } from './toast'

type State = 'idle' | 'working' | 'live' | 'error'

/** Controller for one X video player: pill button, menu, job port, overlay. */
export class PlayerController {
  private root: HTMLDivElement
  private pill: HTMLButtonElement
  private menu: HTMLDivElement | null = null
  private overlay: CaptionOverlay | null = null
  private port: chrome.runtime.Port | null = null
  private state: State = 'idle'
  private cues: Cue[] = []
  private mediaId: string
  private captionsOn = true
  private nudged = false
  private readyNotified = false
  private disposed = false

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
    this.container.appendChild(this.root)
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

  dispose(): void {
    this.disposed = true
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

  private start(force: boolean): void {
    this.setPill('pill_capturing', 'working')
    this.closeMenu()
    this.port?.disconnect()
    const port = chrome.runtime.connect({ name: `${JOB_PORT_PREFIX}${this.mediaId}` })
    this.port = port
    port.onMessage.addListener((ev: JobEvent) => this.onEvent(ev))
    port.onDisconnect.addListener(() => {
      if (this.port === port) this.port = null
      if (!this.disposed && this.state === 'working') this.setPill('pill_error', 'error')
    })
    const req: JobRequest = { kind: 'job/start', mediaId: this.mediaId, force, pageUrl: location.href }
    port.postMessage(req)
  }

  private onEvent(ev: JobEvent): void {
    if (this.disposed) return
    switch (ev.kind) {
      case 'job/progress': {
        if (ev.progress.errorKey) toast(t(ev.progress.errorKey))
        else if (ev.progress.phase === 'fetching_audio') this.setPill('pill_capturing', 'working')
        else if (ev.progress.phase === 'transcribing') this.setPill('pill_transcribing', 'working')
        else if (ev.progress.phase === 'translating') this.setPill('pill_translating', 'working')
        break
      }
      case 'job/utterances': {
        this.cues = ev.cues
        this.ensureOverlay().setCues(this.cues)
        this.setPill('pill_on', 'live') // English is on screen; translation streams in
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
    this.state = state
    this.pill.textContent = t(labelKey)
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

    menu.appendChild(
      this.menuItem(this.captionsOn ? t('menu_hide') : t('menu_show'), () => {
        this.captionsOn = !this.captionsOn
        this.overlay?.setVisible(this.captionsOn)
      }),
    )
    menu.appendChild(this.menuItem(t('menu_export_bilingual'), () => downloadSrt(this.cues, 'bilingual', this.mediaId, lang)))
    menu.appendChild(this.menuItem(t('menu_export_source'), () => downloadSrt(this.cues, 'source', this.mediaId, lang)))
    menu.appendChild(this.menuItem(t('menu_export_target'), () => downloadSrt(this.cues, 'target', this.mediaId, lang)))
    menu.appendChild(this.menuItem(t('menu_retranslate'), () => this.start(true)))
    menu.appendChild(
      this.menuItem(t('menu_settings'), () => {
        void chrome.runtime.sendMessage({ kind: 'options/open' }).catch(() => undefined)
      }),
    )

    this.root.appendChild(menu)
    this.menu = menu
    setTimeout(() => {
      const close = (e: MouseEvent): void => {
        if (!menu.contains(e.target as Node)) this.closeMenu()
      }
      document.addEventListener('click', close, { once: true, capture: true })
    }, 0)
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
    this.menu?.remove()
    this.menu = null
  }
}
