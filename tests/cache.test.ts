import { beforeEach, describe, expect, it } from 'vitest'
import { cacheClear, cacheGet, cachePut, purgeOldCaches } from '../src/core/cache'
import { cacheIdentity, DEFAULT_SETTINGS, llmCacheTag, type Settings } from '../src/shared/settings'
import type { CaptionResult } from '../src/shared/types'

// Minimal in-memory chrome.storage.local for the cache module.
function installChromeMock(): Map<string, unknown> {
  const store = new Map<string, unknown>()
  const local = {
    get: async (key: string | string[] | null) => {
      if (key == null) return Object.fromEntries(store)
      const keys = Array.isArray(key) ? key : [key]
      const out: Record<string, unknown> = {}
      for (const k of keys) if (store.has(k)) out[k] = store.get(k)
      return out
    },
    set: async (obj: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(obj)) store.set(k, v)
    },
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k)
    },
  }
  ;(globalThis as unknown as { chrome: unknown }).chrome = { storage: { local } }
  return store
}

const settingsFor = (over: Partial<Settings['llm']>): Settings => ({
  ...DEFAULT_SETTINGS,
  llm: { ...DEFAULT_SETTINGS.llm, ...over },
})

const result = (): CaptionResult => ({
  mediaId: 'm1',
  sourceLang: 'en',
  targetLang: 'zh-CN',
  cues: [{ id: 0, start: 0, end: 1, src: 'hi', tgt: '嗨' }],
  createdAt: 0,
  asrProvider: 'deepgram',
  llmProvider: 'openai',
  llmModel: 'gpt-4.1-mini',
})

describe('cache', () => {
  beforeEach(() => installChromeMock())

  it('round-trips put → get when the same engine tag is used (regression: key symmetry)', async () => {
    const s = settingsFor({ provider: 'openai' }) // tag includes the base URL
    const r = result()
    await cachePut(r, llmCacheTag(s))
    expect(await cacheGet(r.mediaId, r.targetLang, llmCacheTag(s))).toEqual(r)
  })

  it('misses when the engine differs (so switching provider/model/base re-translates)', async () => {
    const openai = settingsFor({ provider: 'openai' })
    await cachePut(result(), llmCacheTag(openai))
    // different provider
    expect(await cacheGet('m1', 'zh-CN', llmCacheTag(settingsFor({ provider: 'gemini' })))).toBeNull()
    // same provider+model, different base URL
    expect(
      await cacheGet('m1', 'zh-CN', llmCacheTag(settingsFor({ provider: 'openai', openaiBaseUrl: 'https://other.example/v1' }))),
    ).toBeNull()
    // a reconstructed provider@model tag (the old cachePut bug) must NOT hit
    expect(await cacheGet('m1', 'zh-CN', 'openai@gpt-4.1-mini')).toBeNull()
  })

  it('clears every cached entry across versions', async () => {
    const s = settingsFor({ provider: 'openai' })
    await cachePut(result(), llmCacheTag(s))
    await cacheClear()
    expect(await cacheGet('m1', 'zh-CN', llmCacheTag(s))).toBeNull()
  })

  it('purges only older schema versions, keeping current entries', async () => {
    const store = installChromeMock()
    const s = settingsFor({ provider: 'openai' })
    await cachePut(result(), cacheIdentity(s)) // writes a current (cap:v5:) entry
    store.set('cap:v3:m1:zh-CN:openai@gpt-4.1-mini', { stale: true })
    store.set('cap:v4:m1:zh-CN:openai@gpt-4.1-mini', { stale: true })
    store.set('cap:index:v4', { 'cap:v4:m1:zh-CN:openai@gpt-4.1-mini': 1 })
    await purgeOldCaches()
    expect([...store.keys()].some((k) => k.startsWith('cap:v3:') || k.startsWith('cap:v4:'))).toBe(false)
    expect(await cacheGet('m1', 'zh-CN', cacheIdentity(s))).not.toBeNull() // current survived
  })
})

describe('cacheIdentity (glossary is part of cache identity)', () => {
  beforeEach(() => installChromeMock())

  it('round-trips when the glossary is unchanged', async () => {
    const s = settingsFor({ provider: 'openai' })
    await cachePut(result(), cacheIdentity(s))
    expect(await cacheGet('m1', 'zh-CN', cacheIdentity(s))).not.toBeNull()
  })

  it('misses after the user edits the glossary (so the change re-translates)', async () => {
    const before = settingsFor({ provider: 'openai' })
    await cachePut(result(), cacheIdentity(before))
    const after = { ...before, asr: { ...before.asr, customTerms: 'agent=代理' } }
    expect(cacheIdentity(after)).not.toBe(cacheIdentity(before))
    expect(await cacheGet('m1', 'zh-CN', cacheIdentity(after))).toBeNull()
  })
})
