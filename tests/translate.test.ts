import { describe, expect, it } from 'vitest'
import { extractItems } from '../src/core/translate/prompt'
import { translateCues, type TranslateProvider } from '../src/core/translate'
import type { Cue } from '../src/shared/types'

describe('extractItems', () => {
  it('parses the canonical shape', () => {
    expect(extractItems('{"items":[{"i":0,"t":"你好"},{"i":1,"t":"世界"}]}')).toEqual([
      { i: 0, t: '你好' },
      { i: 1, t: '世界' },
    ])
  })

  it('tolerates markdown fences and leading prose', () => {
    const text = 'Here you go:\n```json\n{"items":[{"i":3,"t":"好的"}]}\n```'
    expect(extractItems(text)).toEqual([{ i: 3, t: '好的' }])
  })

  it('accepts a bare array', () => {
    expect(extractItems('[{"i":2,"t":"测试"}]')).toEqual([{ i: 2, t: '测试' }])
  })

  it('captures the echoed source when present', () => {
    expect(extractItems('{"items":[{"i":0,"s":"hello","t":"你好"}]}')).toEqual([
      { i: 0, t: '你好', src: 'hello' },
    ])
  })

  it('drops malformed entries but keeps valid ones', () => {
    expect(extractItems('{"items":[{"i":0,"t":"ok"},{"i":"x","t":1},{"t":"no id"}]}')).toEqual([
      { i: 0, t: 'ok' },
    ])
  })

  it('returns empty on garbage', () => {
    expect(extractItems('Sorry, I cannot do that.')).toEqual([])
    expect(extractItems('')).toEqual([])
  })
})

function fakeProvider(impl: TranslateProvider['translateBatch']): TranslateProvider {
  return { id: 'openai', translateBatch: impl, testKey: async () => true }
}

const cues: Cue[] = Array.from({ length: 5 }, (_, id) => ({
  id,
  start: id,
  end: id + 1,
  src: `line ${id}`,
}))

const baseOpts = { key: 'k', model: 'm', targetLang: 'zh-CN' }

/** Faithful reply: one item per id, in order, echoing the source back. */
const faithful: TranslateProvider['translateBatch'] = async (items) =>
  items.map((it) => ({ i: it.i, src: it.t, t: `译${it.i}` }))

describe('translateCues', () => {
  it('trusts a faithful batch (ids + source echoed) and reports batches via onBatch', async () => {
    const events: number[][] = []
    let calls = 0
    const provider = fakeProvider(async (items) => {
      calls++
      return items.map((it) => ({ i: it.i, src: it.t, t: `译${it.i}` }))
    })
    const result = await translateCues(cues, provider, {
      ...baseOpts,
      batchSize: 2,
      onBatch: (ids) => events.push([...ids]),
    })
    expect(result.size).toBe(5)
    expect(result.get(4)).toBe('译4')
    expect(events).toEqual([[0, 1], [2, 3], [4]])
    expect(calls).toBe(3) // one call per batch — trusted, no bisection
  })

  it('catches a same-count reply that echoes ids correctly but shifts the translations', async () => {
    // The proven hole: the model numbers its slots right (ids in order, non-empty)
    // but each translation — and the source it echoes — belongs to the NEXT line.
    // The source-echo check rejects it; bisection then re-pairs every cue.
    const shifted: TranslateProvider['translateBatch'] = async (items) => {
      if (items.length === 1) return [{ i: items[0]!.i, src: items[0]!.t, t: `译${items[0]!.i}` }]
      const n = items.length
      return items.map((it, k) => ({ i: it.i, src: items[(k + 1) % n]!.t, t: `译${items[(k + 1) % n]!.i}` }))
    }
    const result = await translateCues(cues, fakeProvider(shifted), { ...baseOpts, batchSize: 5 })
    expect(result.size).toBe(5)
    for (const c of cues) expect(result.get(c.id)).toBe(`译${c.id}`) // each id ↦ its OWN translation
  })

  it('recovers when the model merges a split sentence (returns fewer, shifted lines)', async () => {
    const merging: TranslateProvider['translateBatch'] = async (items) => {
      if (items.length === 1) return [{ i: items[0]!.i, src: items[0]!.t, t: `译${items[0]!.i}` }]
      // drop the last, shift the rest: id[k] gets line[k+1]'s source+translation
      return items.slice(1).map((it, k) => ({ i: items[k]!.i, src: it.t, t: `译${it.i}` }))
    }
    const result = await translateCues(cues, fakeProvider(merging), { ...baseOpts, batchSize: 5 })
    expect(result.size).toBe(5)
    for (const c of cues) expect(result.get(c.id)).toBe(`译${c.id}`)
  })

  it('stays aligned even when the model never echoes the source (degrades to per-line)', async () => {
    // No source echo at all → a multi-line batch can never be verified, so it is
    // bisected to single cues, which are aligned by construction.
    const noSrc: TranslateProvider['translateBatch'] = async (items) =>
      items.map((it) => ({ i: it.i, t: `译${it.i}` }))
    const result = await translateCues(cues, fakeProvider(noSrc), { ...baseOpts, batchSize: 5 })
    expect(result.size).toBe(5)
    for (const c of cues) expect(result.get(c.id)).toBe(`译${c.id}`)
  })

  it('tolerates whitespace/case differences in the echoed source', async () => {
    let calls = 0
    const provider = fakeProvider(async (items) => {
      calls++
      // cosmetic-only differences: padded + upper-cased source echo
      return items.map((it) => ({ i: it.i, src: `  ${it.t.toUpperCase()}  `, t: `译${it.i}` }))
    })
    const result = await translateCues(cues.slice(0, 3), provider, { ...baseOpts, batchSize: 3 })
    expect(result.size).toBe(3)
    expect(calls).toBe(1) // trusted despite the cosmetic source differences — no bisection
  })

  it('leaves a cue untranslated when its line never comes back (no throw)', async () => {
    // id 2 is dropped from every reply (multi and single) — it must end up
    // untranslated, and must not steal another line's translation.
    const provider = fakeProvider(async (items) =>
      items.filter((it) => it.i !== 2).map((it) => ({ i: it.i, src: it.t, t: `译${it.i}` })),
    )
    const result = await translateCues(cues.slice(0, 3), provider, { ...baseOpts, batchSize: 3 })
    expect(result.has(2)).toBe(false)
    expect(result.get(0)).toBe('译0')
    expect(result.get(1)).toBe('译1')
  })

  it('never sends timestamps to the provider', async () => {
    let sawKeys: string[] = []
    const provider = fakeProvider(async (items) => {
      sawKeys = Object.keys(items[0]!)
      return items.map((it) => ({ i: it.i, src: it.t, t: 'x' }))
    })
    await translateCues(cues.slice(0, 1), provider, baseOpts)
    expect(sawKeys.sort()).toEqual(['i', 't'])
  })
})
