import type { CaptionResult } from '../shared/types'

/**
 * Result cache in chrome.storage.local with LRU eviction. Re-watching a video
 * (or reopening the tab) must not re-pay ASR + translation.
 */

// v3: cache identity now includes the LLM engine (provider@model), so switching
// translator re-runs and each variant is cached separately for comparison.
// (v2 added the translation-alignment fix; v1 predated it.)
const NAMESPACE = 'cap:'
const PREFIX = 'cap:v3:'
const INDEX_KEY = 'cap:index:v3'
const MAX_ENTRIES = 60

type CacheIndex = Record<string, number> // key -> lastUsed epoch ms

/** `llmTag` is `${provider}@${model}` — see llmCacheTag in settings. */
function keyFor(mediaId: string, targetLang: string, llmTag: string): string {
  return `${PREFIX}${mediaId}:${targetLang}:${llmTag}`
}

export async function cacheGet(mediaId: string, targetLang: string, llmTag: string): Promise<CaptionResult | null> {
  const key = keyFor(mediaId, targetLang, llmTag)
  const raw = await chrome.storage.local.get(key)
  const result = (raw[key] as CaptionResult | undefined) ?? null
  if (result) void touch(key)
  return result
}

export async function cachePut(result: CaptionResult): Promise<void> {
  const key = keyFor(result.mediaId, result.targetLang, `${result.llmProvider}@${result.llmModel}`)
  await chrome.storage.local.set({ [key]: result })
  await touch(key)
}

/** Remove every cached result and index, across ALL schema versions. */
export async function cacheClear(): Promise<void> {
  const all = await chrome.storage.local.get(null)
  const keys = Object.keys(all).filter((k) => k.startsWith(NAMESPACE))
  if (keys.length > 0) await chrome.storage.local.remove(keys)
}

/**
 * Drop caches written by an older schema version (e.g. v1, which predates the
 * translation-alignment fix). Run once at startup so a version bump doesn't leak
 * the previous version's entries into storage forever.
 */
export async function purgeOldCaches(): Promise<void> {
  const all = await chrome.storage.local.get(null)
  const stale = Object.keys(all).filter(
    (k) => k.startsWith(NAMESPACE) && !k.startsWith(PREFIX) && k !== INDEX_KEY,
  )
  if (stale.length > 0) await chrome.storage.local.remove(stale)
}

async function readIndex(): Promise<CacheIndex> {
  const raw = await chrome.storage.local.get(INDEX_KEY)
  return (raw[INDEX_KEY] as CacheIndex | undefined) ?? {}
}

async function touch(key: string): Promise<void> {
  const index = await readIndex()
  index[key] = Date.now()
  const keys = Object.keys(index)
  if (keys.length > MAX_ENTRIES) {
    const evict = keys.sort((a, b) => index[a]! - index[b]!).slice(0, keys.length - MAX_ENTRIES)
    for (const k of evict) delete index[k]
    await chrome.storage.local.remove(evict)
  }
  await chrome.storage.local.set({ [INDEX_KEY]: index })
}
