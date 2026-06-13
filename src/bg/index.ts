import { cacheClear, cacheGet } from '../core/cache'
import { JOB_PORT_PREFIX, type JobRequest, type RuntimeRequest, type RuntimeResponse } from '../shared/messages'
import { asrKeyFor, llmKeyFor, loadSettings } from '../shared/settings'
import { initCapture, lookupMedia } from './capture'
import { initDevReload } from './devReload'
import { attachPort } from './pipeline'

initCapture()
initDevReload()

chrome.runtime.onMessage.addListener(
  (msg: RuntimeRequest, _sender, sendResponse: (res: RuntimeResponse) => void) => {
    void (async () => {
      switch (msg.kind) {
        case 'media/lookup': {
          const found = (await lookupMedia(msg.mediaId)) !== null
          sendResponse({ kind: 'media/lookup', found })
          break
        }
        case 'cache/get': {
          const result = await cacheGet(msg.mediaId, msg.targetLang)
          sendResponse({ kind: 'cache/get', result })
          break
        }
        case 'cache/clear': {
          await cacheClear()
          sendResponse({ kind: 'cache/clear', ok: true })
          break
        }
        case 'options/open': {
          await chrome.runtime.openOptionsPage()
          sendResponse({ kind: 'options/open', ok: true })
          break
        }
        case 'keys/status': {
          const s = await loadSettings()
          sendResponse({
            kind: 'keys/status',
            asrConfigured: Boolean(asrKeyFor(s)),
            llmConfigured: Boolean(llmKeyFor(s)),
          })
          break
        }
      }
    })()
    return true // async response
  },
)

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith(JOB_PORT_PREFIX)) return
  port.onMessage.addListener((msg: JobRequest) => {
    if (msg.kind === 'job/start') attachPort(port, msg)
  })
})
