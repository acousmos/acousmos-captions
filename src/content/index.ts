import { loadSettings, onSettingsChanged, type Settings } from '../shared/settings'
import { PlayerController } from './player'

/**
 * Content script entry. X is a SPA, so players appear and disappear
 * continuously — a throttled MutationObserver scans for new <video> elements
 * and attaches a controller per player. GIF players (no audio) are skipped.
 */

const controllers = new Map<HTMLVideoElement, PlayerController>()
const skipped = new WeakSet<HTMLVideoElement>()
let settings: Settings | null = null

void (async () => {
  settings = await loadSettings()
  if (!settings.display.enabled) {
    // Still watch for re-enable.
    onSettingsChanged(onSettings)
    return
  }
  onSettingsChanged(onSettings)
  scan()
  observe()
})()

function onSettings(s: Settings): void {
  settings = s
  for (const c of controllers.values()) c.updateSettings(s)
  if (s.display.enabled) {
    scan()
    observe()
  }
}

let observer: MutationObserver | null = null
let scanScheduled = false

function observe(): void {
  if (observer) return
  observer = new MutationObserver(() => {
    if (scanScheduled) return
    scanScheduled = true
    setTimeout(() => {
      scanScheduled = false
      scan()
    }, 500)
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
}

function scan(): void {
  if (!settings?.display.enabled) return

  // Drop controllers whose video left the DOM (SPA navigation).
  for (const [video, controller] of controllers) {
    if (!video.isConnected) {
      controller.dispose()
      controllers.delete(video)
    }
  }

  for (const video of document.querySelectorAll('video')) {
    if (controllers.has(video) || skipped.has(video)) continue
    const id = PlayerController.mediaIdFor(video)
    if (id === null) continue // poster not ready yet — next scan may resolve it
    if (id === 'gif') {
      skipped.add(video)
      continue
    }
    const container = containerFor(video)
    if (!container) continue
    controllers.set(video, new PlayerController(video, container, settings, id.id))
  }
}

/** The positioned ancestor our UI mounts into. */
function containerFor(video: HTMLVideoElement): HTMLElement | null {
  const component = video.closest<HTMLElement>('[data-testid="videoComponent"]')
  const el = component ?? video.parentElement
  if (!el) return null
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
  return el
}
