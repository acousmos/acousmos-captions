import type { LlmProviderId } from '../../shared/types'

/** One unit of translation work: the cue id anchors the result. */
export interface BatchItem {
  i: number
  t: string
  /**
   * On a model REPLY only: the source line the model claims it translated,
   * copied back verbatim. The caller compares it to the real source to confirm
   * the translation is on the right line (id echo alone can't catch a reply that
   * numbers its slots correctly but mis-assigns the translations). Unset on input.
   */
  src?: string
}

export interface TranslateContext {
  targetLang: string
  /** Tail of the previously translated source lines, for continuity. */
  prevSource: string[]
  /** Comma-joined glossary of canonical term spellings. */
  glossary?: string
}

export interface TranslateOptions {
  key: string
  model: string
  /** OpenAI-compatible base URL (ignored by Anthropic). */
  baseUrl?: string
  signal?: AbortSignal
}

export interface TranslateProvider {
  readonly id: LlmProviderId
  /**
   * Translate one batch and return the model's items in REPLY ORDER (not keyed).
   * The caller validates the id echo and decides how to map them — a model that
   * merges or renumbers lines must not be allowed to silently shift the mapping.
   * Implementations never see or touch timestamps.
   */
  translateBatch(items: BatchItem[], ctx: TranslateContext, opts: TranslateOptions): Promise<BatchItem[]>
  testKey(key: string, opts: { model: string; baseUrl?: string }): Promise<boolean>
}
