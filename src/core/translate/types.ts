import type { LlmProviderId } from '../../shared/types'

/** One unit of translation work: the cue id anchors the result. */
export interface BatchItem {
  i: number
  t: string
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
   * Translate one batch. Must return results keyed by the input ids.
   * Implementations never see or touch timestamps.
   */
  translateBatch(items: BatchItem[], ctx: TranslateContext, opts: TranslateOptions): Promise<Map<number, string>>
  testKey(key: string, opts: { model: string; baseUrl?: string }): Promise<boolean>
}
