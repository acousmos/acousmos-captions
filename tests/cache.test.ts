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
    await cachePut(result(), cacheIdentity(s, 'asr')) // writes a current (cap:v5:) entry
    store.set('cap:v3:m1:zh-CN:openai@gpt-4.1-mini', { stale: true })
    store.set('cap:v4:m1:zh-CN:openai@gpt-4.1-mini', { stale: true })
    store.set('cap:index:v4', { 'cap:v4:m1:zh-CN:openai@gpt-4.1-mini': 1 })
    await purgeOldCaches()
    expect([...store.keys()].some((k) => k.startsWith('cap:v3:') || k.startsWith('cap:v4:'))).toBe(false)
    expect(await cacheGet('m1', 'zh-CN', cacheIdentity(s, 'asr'))).not.toBeNull() // current survived
  })
})

describe('cacheIdentity (glossary + source are part of cache identity)', () => {
  beforeEach(() => installChromeMock())

  it('round-trips when nothing relevant changed', async () => {
    const s = settingsFor({ provider: 'openai' })
    await cachePut(result(), cacheIdentity(s, 'asr'))
    expect(await cacheGet('m1', 'zh-CN', cacheIdentity(s, 'asr'))).not.toBeNull()
  })

  it('misses after the user edits the glossary (so the change re-translates)', async () => {
    const before = settingsFor({ provider: 'openai' })
    await cachePut(result(), cacheIdentity(before, 'asr'))
    const after = { ...before, asr: { ...before.asr, customTerms: 'agent=代理' } }
    expect(cacheIdentity(after, 'asr')).not.toBe(cacheIdentity(before, 'asr'))
    expect(await cacheGet('m1', 'zh-CN', cacheIdentity(after, 'asr'))).toBeNull()
  })

  it('keeps native and ASR sources on separate keys (re-transcribe ≠ overwrite native)', async () => {
    const s = settingsFor({ provider: 'openai' })
    await cachePut(result(), cacheIdentity(s, 'native'))
    expect(cacheIdentity(s, 'native')).not.toBe(cacheIdentity(s, 'asr'))
    expect(await cacheGet('m1', 'zh-CN', cacheIdentity(s, 'native'))).not.toBeNull()
    expect(await cacheGet('m1', 'zh-CN', cacheIdentity(s, 'asr'))).toBeNull() // ASR didn't clobber native
  })

  it('ASR source: provider and source language are part of the identity', async () => {
    const base = settingsFor({})
    const asrBase: Settings = { ...base, asr: { ...base.asr, provider: 'deepgram', sourceLang: 'auto' } }
    const otherProvider: Settings = { ...asrBase, asr: { ...asrBase.asr, provider: 'soniox' } }
    const otherLang: Settings = { ...asrBase, asr: { ...asrBase.asr, sourceLang: 'en' } }
    expect(cacheIdentity(otherProvider, 'asr')).not.toBe(cacheIdentity(asrBase, 'asr'))
    expect(cacheIdentity(otherLang, 'asr')).not.toBe(cacheIdentity(asrBase, 'asr'))
  })

  it('native source: the ASR provider is irrelevant (no needless re-run)', async () => {
    const base = settingsFor({})
    const deepgram: Settings = { ...base, asr: { ...base.asr, provider: 'deepgram' } }
    const soniox: Settings = { ...base, asr: { ...base.asr, provider: 'soniox' } }
    expect(cacheIdentity(soniox, 'native')).toBe(cacheIdentity(deepgram, 'native'))
  })
})
