import type { Cue, Utterance, Word } from '../shared/types'

export interface CueOptions {
  /** Hard cap on source characters per cue (a run-on is split here). */
  maxChars: number
  /** Hard cap on cue duration in seconds. */
  maxDur: number
  /** Don't end a cue on a sentence boundary shorter than this (merges
   *  interjections like "Um." into the neighbouring sentence). */
  softMin: number
  /** Once a cue reaches this length, also break it at clause boundaries
   *  (commas) so long sentences don't become walls of text. */
  clauseMin: number
  /** A pause this long (s) after sentence-final punctuation ends the cue
   *  even below softMin. */
  shortGap: number
  /** Any silence this long (s) ends the cue regardless of punctuation. */
  hardGap: number
  /** Minimum on-screen duration; a cue's end is stretched up to the next. */
  minDur: number
}

/**
 * Defaults tuned for spoken talks: cues are whole sentences where possible
 * (so translation sees complete thoughts), but a long sentence breaks at
 * clause boundaries so each line stays readable and gets its own timing.
 */
export const DEFAULT_CUE_OPTIONS: CueOptions = {
  maxChars: 110,
  maxDur: 10,
  softMin: 10,
  clauseMin: 60,
  shortGap: 0.4,
  hardGap: 1.5,
  minDur: 1.0,
}

const SENTENCE_END = /[.!?。！？…]["'”’)\]]?$/
const CLAUSE_END = /[,;:，；：、]["'”’)\]]?$/

/**
 * Build display cues from ASR utterances.
 *
 * Timestamp policy: cue boundaries are always ASR-produced word/utterance
 * timestamps. This step groups words into sentence-sized cues — merging across
 * ASR utterance boundaries when a sentence was split (e.g. "…Google" + "Cloud?"
 * → one cue) and splitting only when a cap is exceeded. Translation later never
 * touches timing; it only fills `tgt` keyed by cue id.
 */
export function buildCues(utterances: Utterance[], opts: CueOptions = DEFAULT_CUE_OPTIONS): Cue[] {
  const words = flattenWords(utterances)
  if (words.length === 0) return []

  const cues: Omit<Cue, 'id'>[] = []
  let bucket: Word[] = []
  let chars = 0

  const flush = (): void => {
    if (bucket.length === 0) return
    const first = bucket[0]!
    const last = bucket[bucket.length - 1]!
    const src = joinWords(bucket)
    if (src) cues.push({ start: first.start, end: last.end, src })
    bucket = []
    chars = 0
  }

  for (const w of words) {
    if (bucket.length > 0) {
      const prev = bucket[bucket.length - 1]!
      const start = bucket[0]!.start
      const gap = w.start - prev.end
      const wouldExceed = chars + w.text.length + 1 > opts.maxChars || w.end - start > opts.maxDur
      const sentenceBoundary =
        SENTENCE_END.test(prev.text) && (chars >= opts.softMin || gap >= opts.shortGap)
      // Once a line is long, break it at a clause boundary too, so a long
      // sentence becomes a few readable, separately-timed lines.
      const clauseBoundary = CLAUSE_END.test(prev.text) && chars >= opts.clauseMin
      if (wouldExceed || sentenceBoundary || clauseBoundary || gap >= opts.hardGap) flush()
    }
    bucket.push(w)
    chars += w.text.length + 1
  }
  flush()

  // Readability: guarantee a minimum on-screen time without overrunning the
  // next cue's ASR anchor.
  for (let i = 0; i < cues.length; i++) {
    const cur = cues[i]!
    const next = cues[i + 1]
    if (cur.end - cur.start < opts.minDur) {
      const cap = next ? next.start : cur.start + opts.minDur
      cur.end = Math.min(cur.start + opts.minDur, Math.max(cur.end, cap))
      if (cur.end <= cur.start) cur.end = cur.start + 0.1
    }
  }

  return cues.map((c, id) => ({ id, ...c }))
}

/** Flatten utterances into a single time-ordered word stream. */
function flattenWords(utterances: Utterance[]): Word[] {
  const words: Word[] = []
  for (const u of utterances) {
    if (u.words && u.words.length > 0) {
      for (const w of u.words) {
        const text = w.text.trim()
        if (text) words.push({ text, start: w.start, end: w.end })
      }
    } else {
      const text = u.text.trim()
      if (text) words.push({ text, start: u.start, end: u.end })
    }
  }
  words.sort((a, b) => a.start - b.start)
  return words
}

/** Join words, omitting the space between CJK neighbours. */
function joinWords(words: Word[]): string {
  let out = ''
  for (const w of words) {
    if (!out) {
      out = w.text
      continue
    }
    const cjk = /[　-〿㐀-鿿＀-￯]/
    out += cjk.test(out.slice(-1)) && cjk.test(w.text[0] ?? '') ? w.text : ` ${w.text}`
  }
  return out.trim()
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
