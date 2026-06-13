import { describe, expect, it } from 'vitest'
import { buildCues, DEFAULT_CUE_OPTIONS, findCueIndex, lastCueIndexBefore } from '../src/core/cues'
import type { Utterance } from '../src/shared/types'

describe('buildCues', () => {
  it('keeps short utterances as-is with sequential ids', () => {
    const utts: Utterance[] = [
      { start: 0, end: 2, text: 'Hello there.' },
      { start: 3, end: 5, text: 'Welcome back.' },
    ]
    const cues = buildCues(utts)
    expect(cues).toHaveLength(2)
    expect(cues[0]).toMatchObject({ id: 0, start: 0, end: 2, src: 'Hello there.' })
    expect(cues[1]).toMatchObject({ id: 1, start: 3, end: 5 })
  })

  it('merges adjacent short utterances within the gap threshold', () => {
    const utts: Utterance[] = [
      { start: 0, end: 1, text: 'Hi.' },
      { start: 1.2, end: 2.2, text: 'Quick note.' },
      { start: 9, end: 10, text: 'Far away.' },
    ]
    const cues = buildCues(utts)
    expect(cues).toHaveLength(2)
    expect(cues[0]?.src).toBe('Hi. Quick note.')
    expect(cues[0]?.start).toBe(0)
    expect(cues[0]?.end).toBe(2.2)
  })

  it('never merges past maxChars', () => {
    const a = 'x'.repeat(50)
    const b = 'y'.repeat(50)
    const cues = buildCues([
      { start: 0, end: 1, text: a },
      { start: 1.1, end: 2, text: b },
    ])
    expect(cues).toHaveLength(2)
  })

  it('splits overlong utterances at word boundaries (ASR anchors preserved)', () => {
    const words = Array.from({ length: 40 }, (_, i) => ({
      text: `word${i}`,
      start: i * 0.5,
      end: i * 0.5 + 0.4,
    }))
    const utts: Utterance[] = [
      { start: 0, end: 20, text: words.map((w) => w.text).join(' '), words },
    ]
    const cues = buildCues(utts)
    expect(cues.length).toBeGreaterThan(1)
    for (const c of cues) {
      expect(c.src.length).toBeLessThanOrEqual(DEFAULT_CUE_OPTIONS.maxChars)
      // Every boundary must be a word timestamp.
      const starts = words.map((w) => w.start)
      const ends = words.map((w) => w.end)
      expect(starts).toContain(c.start)
      expect(ends).toContain(c.end)
    }
    // No reordering, full coverage.
    const text = cues.map((c) => c.src).join(' ')
    expect(text).toBe(words.map((w) => w.text).join(' '))
  })

  it('extends too-short cues up to the next cue start', () => {
    const cues = buildCues(
      [
        { start: 0, end: 0.2, text: 'Blink text that should stay readable for a moment' },
        { start: 5, end: 6, text: 'Later line' },
      ],
      { ...DEFAULT_CUE_OPTIONS, mergeGap: 0.1 },
    )
    expect(cues[0]!.end).toBeGreaterThanOrEqual(DEFAULT_CUE_OPTIONS.minDur)
    expect(cues[0]!.end).toBeLessThanOrEqual(5)
  })

  it('joins CJK without inserting spaces', () => {
    const cues = buildCues([
      { start: 0, end: 1, text: '你好' },
      { start: 1.1, end: 2, text: '世界' },
    ])
    expect(cues[0]?.src).toBe('你好世界')
  })
})

describe('findCueIndex', () => {
  const cues = buildCues([
    { start: 0, end: 2, text: 'a' },
    { start: 3, end: 5, text: 'b' },
    { start: 6, end: 8, text: 'c' },
  ])
  it('finds covering cue', () => {
    expect(findCueIndex(cues, 1)).toBe(0)
    expect(findCueIndex(cues, 4)).toBe(1)
    expect(findCueIndex(cues, 7.9)).toBe(2)
  })
  it('returns -1 in gaps and outside range', () => {
    expect(findCueIndex(cues, 2.5)).toBe(-1)
    expect(findCueIndex(cues, 100)).toBe(-1)
  })
})

describe('lastCueIndexBefore', () => {
  const cues = buildCues([
    { start: 0, end: 2, text: 'a' },
    { start: 3, end: 5, text: 'b' },
    { start: 6, end: 8, text: 'c' },
  ])
  it('returns the covering cue when inside one', () => {
    expect(lastCueIndexBefore(cues, 4)).toBe(1)
  })
  it('returns the most recent preceding cue when in a gap (linger when paused)', () => {
    expect(lastCueIndexBefore(cues, 2.5)).toBe(0)
    expect(lastCueIndexBefore(cues, 5.5)).toBe(1)
    expect(lastCueIndexBefore(cues, 100)).toBe(2)
  })
  it('returns -1 before the first cue', () => {
    expect(lastCueIndexBefore(cues, -1)).toBe(-1)
  })
})
