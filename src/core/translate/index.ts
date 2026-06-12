import type { Cue, LlmProviderId } from '../../shared/types'
import { anthropic } from './anthropic'
import { openaiCompat } from './openai'
import type { BatchItem, TranslateOptions, TranslateProvider } from './types'

const providers: Record<LlmProviderId, TranslateProvider> = {
  openai: openaiCompat,
  anthropic,
}

export function getTranslateProvider(id: LlmProviderId): TranslateProvider {
  return providers[id]
}

export interface TranslateRunOptions extends TranslateOptions {
  targetLang: string
  batchSize?: number
  /** Called as each batch completes, in completion order. */
  onBatch?: (ids: number[], texts: string[]) => void
}

const BATCH_SIZE = 40
const CONTEXT_LINES = 2

/**
 * Translate all cues batch-by-batch. Timestamps are never sent to the LLM —
 * only (id, text) pairs — so the timeline cannot be disturbed by translation.
 * Ids missing from a batch response are retried once individually; cues that
 * still fail keep `tgt` unset (the UI falls back to the original line).
 */
export async function translateCues(
  cues: readonly Cue[],
  provider: TranslateProvider,
  opts: TranslateRunOptions,
): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const size = opts.batchSize ?? BATCH_SIZE
  const batches: BatchItem[][] = []
  for (let i = 0; i < cues.length; i += size) {
    batches.push(cues.slice(i, i + size).map((c) => ({ i: c.id, t: c.src })))
  }

  for (let b = 0; b < batches.length; b++) {
    const items = batches[b]!
    const prevSource = b > 0 ? batches[b - 1]!.slice(-CONTEXT_LINES).map((x) => x.t) : []
    const ctx = { targetLang: opts.targetLang, prevSource }

    let result: Map<number, string>
    try {
      result = await provider.translateBatch(items, ctx, opts)
    } catch (e) {
      if (opts.signal?.aborted) throw e
      result = new Map()
      // Whole-batch failure: fall through to per-item retry below.
    }

    const missing = items.filter((it) => !result.get(it.i))
    for (const it of missing) {
      if (opts.signal?.aborted) break
      try {
        const single = await provider.translateBatch([it], ctx, opts)
        const t = single.get(it.i)
        if (t) result.set(it.i, t)
      } catch {
        // leave untranslated; UI shows the original line
      }
    }

    const ids: number[] = []
    const texts: string[] = []
    for (const it of items) {
      const t = result.get(it.i)
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

export type { BatchItem, TranslateContext, TranslateOptions, TranslateProvider } from './types'
