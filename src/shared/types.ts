/** A word/token with absolute timestamps in seconds. */
export interface Word {
  text: string
  start: number
  end: number
}

/** An ASR utterance: contiguous speech with absolute timestamps in seconds. */
export interface Utterance {
  start: number
  end: number
  text: string
  words?: Word[]
}

/**
 * A display cue. Timestamps come from ASR and are immutable anchors:
 * translation never reorders, splits, or re-times cues.
 */
export interface Cue {
  /** Stable index within the result; used as the translation anchor id. */
  id: number
  start: number
  end: number
  src: string
  /** Translated line; absent until the translation batch covering it lands. */
  tgt?: string
}

export interface CaptionResult {
  mediaId: string
  sourceLang: string
  targetLang: string
  cues: Cue[]
  createdAt: number
  /** Provider ids, for display/debugging. */
  asrProvider: string
  llmProvider: string
}

export type AsrProviderId = 'deepgram' | 'soniox'
export type LlmProviderId = 'openai' | 'anthropic' | 'gemini'

export interface AudioPayload {
  bytes: Uint8Array
  mime: string
}

export type JobPhase =
  | 'queued'
  | 'fetching_audio'
  | 'transcribing'
  | 'translating'
  | 'done'
  | 'error'

export interface JobProgress {
  phase: JobPhase
  /** 0..1 within the current phase, where known. */
  ratio?: number
  /** i18n message key for user-facing errors; `detail` is raw/technical. */
  errorKey?: string
  detail?: string
}

/** Errors carrying a user-facing i18n key. */
export class JobError extends Error {
  constructor(
    public readonly key: string,
    detail?: string,
  ) {
    super(detail ?? key)
    this.name = 'JobError'
  }
}
