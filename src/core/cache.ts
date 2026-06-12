import type { CaptionResult } from '../shared/types'

/**
 * Result cache in chrome.storage.local with LRU eviction. Re-watching a video
 * (or reopening the tab) must not re-pay ASR + translation.
 */

const PREFIX = 'cap:v1:'
const INDEX_KEY = 'cap:index:v1'
const MAX_ENTRIES = 60

type CacheIndex = Record<string, number> // key -> lastUsed epoch ms

function keyFor(mediaId: string, targetLang: string): string {
  return `${PREFIX}${mediaId}:${targetLang}`
}

export async function cacheGet(mediaId: string, targetLang: string): Promise<CaptionResult | null> {
  const key = keyFor(mediaId, targetLang)
  const raw = await chrome.storage.local.get(key)
  const result = (raw[key] as CaptionResult | undefined) ?? null
  if (result) void touch(key)
  return result
}

export async function cachePut(result: CaptionResult): Promise<void> {
  const key = keyFor(result.mediaId, result.targetLang)
  await chrome.storage.local.set({ [key]: result })
  await touch(key)
}

export async function cacheClear(): Promise<void> {
  const index = await readIndex()
  await chrome.storage.local.remove([...Object.keys(index), INDEX_KEY])
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
