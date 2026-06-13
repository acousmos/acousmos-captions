import type { CaptionResult } from '../shared/types'

/**
 * Result cache in chrome.storage.local with LRU eviction. Re-watching a video
 * (or reopening the tab) must not re-pay ASR + translation.
 */

// v4: cache identity now includes the OpenAI-compatible base URL too (same model
// id at a different endpoint is a different engine). v3 added provider@model; v2
// added the translation-alignment fix; v1 predated it. Old versions self-purge.
const NAMESPACE = 'cap:'
const PREFIX = 'cap:v4:'
const INDEX_KEY = 'cap:index:v4'
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

/** `llmTag` MUST be the same llmCacheTag(settings) used for cacheGet, or the
 *  result is written to a key that's never read (e.g. OpenAI's tag includes the
 *  base URL — a reconstructed provider@model tag would silently never hit). */
export async function cachePut(result: CaptionResult, llmTag: string): Promise<void> {
  const key = keyFor(result.mediaId, result.targetLang, llmTag)
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
