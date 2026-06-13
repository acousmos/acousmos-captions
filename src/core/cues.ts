import type { Cue, Utterance, Word } from '../shared/types'

export interface CueOptions {
  /** Max characters of source text per cue. */
  maxChars: number
  /** Max cue duration in seconds. */
  maxDur: number
  /** Merge adjacent utterances when the silence between them is ≤ this. */
  mergeGap: number
  /** Minimum display duration; cue end is extended up to the next cue. */
  minDur: number
}

export const DEFAULT_CUE_OPTIONS: CueOptions = {
  maxChars: 84,
  maxDur: 7,
  mergeGap: 0.5,
  minDur: 0.8,
}

/**
 * Build display cues from ASR utterances.
 *
 * Timestamp policy: every cue boundary is an ASR-produced timestamp (utterance
 * or word boundary). This step may SPLIT overlong utterances at word
 * boundaries and MERGE adjacent short ones — translation later never touches
 * timing at all (it only fills `tgt` keyed by cue id).
 */
export function buildCues(utterances: Utterance[], opts: CueOptions = DEFAULT_CUE_OPTIONS): Cue[] {
  const pieces: Omit<Cue, 'id'>[] = []
  for (const u of utterances) {
    for (const p of splitUtterance(u, opts)) pieces.push(p)
  }
  pieces.sort((a, b) => a.start - b.start)

  // Merge-only pass.
  const merged: Omit<Cue, 'id'>[] = []
  for (const p of pieces) {
    const prev = merged[merged.length - 1]
    if (
      prev &&
      p.start - prev.end <= opts.mergeGap &&
      p.end - prev.start <= opts.maxDur &&
      prev.src.length + p.src.length + 1 <= opts.maxChars
    ) {
      prev.end = p.end
      prev.src = joinText(prev.src, p.src)
    } else {
      merged.push({ ...p })
    }
  }

  // Readability pass: guarantee a minimum on-screen time without overlapping
  // the next cue's ASR anchor.
  for (let i = 0; i < merged.length; i++) {
    const cur = merged[i]!
    const next = merged[i + 1]
    if (cur.end - cur.start < opts.minDur) {
      const cap = next ? next.start : cur.start + opts.minDur
      cur.end = Math.min(cur.start + opts.minDur, Math.max(cur.end, cap))
      if (cur.end <= cur.start) cur.end = cur.start + 0.1
    }
  }

  return merged.map((p, id) => ({ id, ...p }))
}

function splitUtterance(u: Utterance, opts: CueOptions): Omit<Cue, 'id'>[] {
  const text = u.text.trim()
  if (!text) return []
  const tooLong = text.length > opts.maxChars || u.end - u.start > opts.maxDur
  if (!tooLong || !u.words || u.words.length < 2) {
    return [{ start: u.start, end: u.end, src: text }]
  }

  const out: Omit<Cue, 'id'>[] = []
  let bucket: Word[] = []
  let bucketChars = 0
  const flush = () => {
    if (bucket.length === 0) return
    const first = bucket[0]!
    const last = bucket[bucket.length - 1]!
    out.push({ start: first.start, end: last.end, src: bucket.map((w) => w.text).join(' ').trim() })
    bucket = []
    bucketChars = 0
  }
  for (const w of u.words) {
    const wLen = w.text.length + (bucket.length > 0 ? 1 : 0)
    const start = bucket[0]?.start ?? w.start
    if (bucket.length > 0 && (bucketChars + wLen > opts.maxChars || w.end - start > opts.maxDur)) {
      // Prefer breaking after sentence punctuation when we recently passed one.
      flush()
    }
    bucket.push(w)
    bucketChars += wLen
    const t = w.text
    if (/[.!?。!?…]["')\]]?$/.test(t) && bucketChars > opts.maxChars * 0.5) flush()
  }
  flush()
  return out
}

function joinText(a: string, b: string): string {
  // CJK text concatenates without a space.
  const lastA = a.slice(-1)
  const firstB = b.slice(0, 1)
  const cjk = /[　-鿿豈-﫿]/
  if (cjk.test(lastA) && cjk.test(firstB)) return a + b
  return `${a} ${b}`
}

/** Binary search: index of the cue covering `time`, or -1. */
export function findCueIndex(cues: Cue[], time: number): number {
  let lo = 0
  let hi = cues.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const c = cues[mid]!
    if (time < c.start) hi = mid - 1
    else if (time >= c.end) lo = mid + 1
    else return mid
  }
  return -1
}

/**
 * Index of the last cue starting at or before `time`, or -1 if none.
 * Used to keep the most recent line on screen while the video is paused in a
 * gap between cues (so pausing never blanks the captions).
 */
export function lastCueIndexBefore(cues: Cue[], time: number): number {
  let lo = 0
  let hi = cues.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cues[mid]!.start <= time) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}
