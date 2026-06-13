import type { Cue, LlmProviderId } from '../../shared/types'
import { anthropic } from './anthropic'
import { openaiCompat } from './openai'
import type { BatchItem, TranslateContext, TranslateOptions, TranslateProvider } from './types'

const providers: Record<LlmProviderId, TranslateProvider> = {
  openai: openaiCompat,
  anthropic,
}

export function getTranslateProvider(id: LlmProviderId): TranslateProvider {
  return providers[id]
}

export interface TranslateRunOptions extends TranslateOptions {
  targetLang: string
  /** Comma-joined glossary of canonical term spellings. */
  glossary?: string
  batchSize?: number
  /** Called as each batch completes, in completion order. */
  onBatch?: (ids: number[], texts: string[]) => void
}

const BATCH_SIZE = 40
const CONTEXT_LINES = 2

/**
 * Translate all cues batch-by-batch. Timestamps are never sent to the LLM —
 * only (id, text) pairs — so the timeline cannot be disturbed by translation.
 *
 * Alignment is the hard part. A model that merges two split-sentence fragments,
 * drops a line, renumbers, or simply numbers its output slots correctly while
 * mis-assigning the translations would silently shift later lines onto the wrong
 * cue id. Echoing the ids back is not enough to catch the last case, so each
 * reply must also echo every SOURCE line back unchanged; a batch is trusted only
 * when ids AND sources line up. Any mismatch makes us split the batch and recurse
 * down to single cues, where there is exactly one possible source and the mapping
 * cannot be wrong. Cues that still fail to translate keep `tgt` unset (the UI
 * falls back to the original line).
 */
export async function translateCues(
  cues: readonly Cue[],
  provider: TranslateProvider,
  opts: TranslateRunOptions,
): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const size = opts.batchSize ?? BATCH_SIZE
  const all: BatchItem[] = cues.map((c) => ({ i: c.id, t: c.src }))

  for (let start = 0; start < all.length; start += size) {
    if (opts.signal?.aborted) break
    const batch = all.slice(start, start + size)
    const prevSource = all.slice(Math.max(0, start - CONTEXT_LINES), start).map((x) => x.t)
    const map = await translateChunk(batch, prevSource, provider, opts)

    const ids: number[] = []
    const texts: string[] = []
    for (const it of batch) {
      const t = map.get(it.i)
      if (t) {
        out.set(it.i, t)
        ids.push(it.i)
        texts.push(t)
      }
    }
    if (ids.length > 0) opts.onBatch?.(ids, texts)
  }
  return out
}

/**
 * Translate one chunk and return an id→text map. Trusts the reply only when the
 * model echoes both the ids and the source lines back intact; otherwise splits
 * the chunk and recurses (a single cue is unambiguous regardless of what the
 * model echoes for it).
 */
async function translateChunk(
  batch: BatchItem[],
  prevSource: string[],
  provider: TranslateProvider,
  opts: TranslateRunOptions,
): Promise<Map<number, string>> {
  if (batch.length === 0) return new Map()
  const ctx: TranslateContext = { targetLang: opts.targetLang, prevSource, glossary: opts.glossary }

  let parsed: BatchItem[]
  try {
    parsed = await provider.translateBatch(batch, ctx, opts)
  } catch (e) {
    if (opts.signal?.aborted) throw e
    parsed = [] // treat as a non-echo: recurse / give up below
  }

  // (a) ids echoed exactly, in order, with non-empty translations, AND
  // (b) every source echoed back unchanged — only then is each translation
  // provably anchored to its own line.
  const idsEcho =
    parsed.length === batch.length && batch.every((it, k) => parsed[k]!.i === it.i && parsed[k]!.t.length > 0)
  const srcEcho = idsEcho && batch.every((it, k) => normalizeSrc(parsed[k]!.src ?? '') === normalizeSrc(it.t))
  if (srcEcho) {
    // This proves the model addressed each line in place (it copied each source
    // back), which neutralises the real failure mode: merging split fragments
    // forces either fewer items (idsEcho fails) or a mismatched source echo
    // (srcEcho fails). It does not *prove* the translation text wasn't swapped
    // while the source was still copied faithfully — but a model echoing source_k
    // is anchored to line k, so there is no realistic mechanism for that to recur
    // systematically; the worst residual is an isolated mistranslation, with the
    // original line (the anchor) always correct. A hard structural guarantee, if
    // ever required, is one cue per request.
    return new Map(batch.map((it, k) => [it.i, parsed[k]!.t]))
  }

  if (batch.length === 1) {
    // One source line in → its translation is unambiguous, whatever id or source
    // the model echoed (there is only one slot it could belong to). Empty → leave
    // it untranslated and let the UI fall back to the original line.
    const t = parsed.find((p) => p.t.length > 0)?.t
    return t ? new Map([[batch[0]!.i, t]]) : new Map()
  }
  if (opts.signal?.aborted) return new Map()

  // Untrusted reply: split and recurse. The right half's continuity context is
  // the tail of the left half's source lines.
  const mid = Math.ceil(batch.length / 2)
  const left = batch.slice(0, mid)
  const right = batch.slice(mid)
  const leftMap = await translateChunk(left, prevSource, provider, opts)
  // Right half's continuity context = whatever preceded this chunk plus the left
  // half's sources, trimmed to the last CONTEXT_LINES (so a short left half
  // doesn't starve it of context).
  const rightPrev = [...prevSource, ...left.map((x) => x.t)].slice(-CONTEXT_LINES)
  const rightMap = await translateChunk(right, rightPrev, provider, opts)
  return new Map([...leftMap, ...rightMap])
}

/**
 * Compare a model's echoed source to the real source leniently — robust to
 * whitespace/case/Unicode-form differences (which don't change meaning) but not
 * to a genuinely different line (which signals the translation was misrouted).
 */
function normalizeSrc(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()
}

export type { BatchItem, TranslateContext, TranslateOptions, TranslateProvider } from './types'
