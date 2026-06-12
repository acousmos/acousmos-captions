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

describe('translateCues', () => {
  it('translates all cues and reports batches via onBatch', async () => {
    const events: number[][] = []
    const provider = fakeProvider(async (items) => new Map(items.map((it) => [it.i, `译${it.i}`])))
    const result = await translateCues(cues, provider, {
      ...baseOpts,
      batchSize: 2,
      onBatch: (ids) => events.push([...ids]),
    })
    expect(result.size).toBe(5)
    expect(result.get(4)).toBe('译4')
    expect(events).toEqual([[0, 1], [2, 3], [4]])
  })

  it('retries missing ids individually', async () => {
    let calls = 0
    const provider = fakeProvider(async (items) => {
      calls++
      if (calls === 1) {
        // First batch call "forgets" id 1.
        return new Map(items.filter((it) => it.i !== 1).map((it) => [it.i, `译${it.i}`]))
      }
      return new Map(items.map((it) => [it.i, `译${it.i}`]))
    })
    const result = await translateCues(cues.slice(0, 3), provider, { ...baseOpts, batchSize: 3 })
    expect(result.get(1)).toBe('译1')
    expect(result.size).toBe(3)
    expect(calls).toBe(2) // one batch + one single retry
  })

  it('leaves cues untranslated when retries also fail (no throw)', async () => {
    const provider = fakeProvider(async (items) =>
      new Map(items.filter((it) => it.i !== 2).map((it) => [it.i, `译${it.i}`])),
    )
    const result = await translateCues(cues.slice(0, 3), provider, { ...baseOpts, batchSize: 3 })
    expect(result.has(2)).toBe(false)
    expect(result.size).toBe(2)
  })

  it('never sends timestamps to the provider', async () => {
    let sawKeys: string[] = []
    const provider = fakeProvider(async (items) => {
      sawKeys = Object.keys(items[0]!)
      return new Map(items.map((it) => [it.i, 'x']))
    })
    await translateCues(cues.slice(0, 1), provider, baseOpts)
    expect(sawKeys.sort()).toEqual(['i', 't'])
  })
})
