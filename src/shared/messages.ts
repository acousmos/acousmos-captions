import type { CaptionResult, Cue, JobProgress, Utterance } from './types'

/** One-shot messages (chrome.runtime.sendMessage). */
export type RuntimeRequest =
  | { kind: 'media/lookup'; mediaId: string }
  | { kind: 'cache/get'; mediaId: string; targetLang: string }
  | { kind: 'cache/clear' }
  | { kind: 'keys/status' }
  | { kind: 'options/open' }

export type RuntimeResponse =
  | { kind: 'media/lookup'; found: boolean }
  | { kind: 'cache/get'; result: CaptionResult | null }
  | { kind: 'cache/clear'; ok: true }
  | { kind: 'keys/status'; asrConfigured: boolean; llmConfigured: boolean }
  | { kind: 'options/open'; ok: true }

/** Job port protocol. Port name: `job:<mediaId>`. */
export interface JobRequest {
  kind: 'job/start'
  mediaId: string
  /** Bypass the result cache. */
  force?: boolean
  /** Tweet URL for filename/context, optional. */
  pageUrl?: string
  /** Source cues from the video's own subtitle track; when present, ASR is
   *  skipped and these are translated directly. */
  nativeUtterances?: Utterance[]
}

export type JobEvent =
  | { kind: 'job/debug'; info: string }
  | { kind: 'job/progress'; progress: JobProgress }
  | { kind: 'job/utterances'; cues: Cue[] } // English-first render: cues without tgt
  | { kind: 'job/translated'; ids: number[]; texts: string[] } // patch tgt by cue id
  | { kind: 'job/done'; result: CaptionResult; fromCache: boolean }
  | { kind: 'job/error'; errorKey: string; detail?: string }

export const JOB_PORT_PREFIX = 'job:'
