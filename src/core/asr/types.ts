import type { AsrProviderId, AudioPayload, Utterance } from '../../shared/types'

export interface AsrOptions {
  key: string
  /** 'auto' or a language code like 'en'. */
  sourceLang: string
  /** Glossary terms to bias recognition (built-in + user custom). */
  terms?: string[]
  signal?: AbortSignal
  onProgress?: (ratio: number) => void
}

export interface AsrProvider {
  readonly id: AsrProviderId
  transcribe(audio: AudioPayload, opts: AsrOptions): Promise<Utterance[]>
  /** Cheap authenticated call to validate a key from the options page. */
  testKey(key: string): Promise<boolean>
}
