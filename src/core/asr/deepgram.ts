import { JobError, type AudioPayload, type Utterance, type Word } from '../../shared/types'
import { fetchRetry, readErrorBody } from '../../shared/net'
import type { AsrOptions, AsrProvider } from './types'

const API = 'https://api.deepgram.com/v1'

interface DgWord {
  word: string
  start: number
  end: number
  punctuated_word?: string
}

interface DgUtterance {
  start: number
  end: number
  transcript: string
  words?: DgWord[]
}

interface DgResponse {
  results?: {
    utterances?: DgUtterance[]
    channels?: { alternatives?: { transcript?: string; words?: DgWord[] }[] }[]
  }
}

export const deepgram: AsrProvider = {
  id: 'deepgram',

  async transcribe(audio: AudioPayload, opts: AsrOptions): Promise<Utterance[]> {
    const params = new URLSearchParams({
      model: 'nova-3',
      smart_format: 'true',
      utterances: 'true',
      punctuate: 'true',
    })
    if (opts.sourceLang === 'auto') params.set('detect_language', 'true')
    else params.set('language', opts.sourceLang)
    // Keyterm prompting (nova-3) boosts recognition of glossary terms.
    for (const term of opts.terms ?? []) params.append('keyterm', term)

    const res = await fetchRetry(
      `${API}/listen?${params}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${opts.key}`,
          'Content-Type': audio.mime,
        },
        body: audio.bytes as unknown as BodyInit,
      },
      { signal: opts.signal, timeoutMs: 180_000 },
    )
    if (res.status === 401 || res.status === 403) {
      throw new JobError('err_asr_auth', await readErrorBody(res))
    }
    if (!res.ok) {
      throw new JobError('err_asr_failed', `Deepgram HTTP ${res.status}: ${await readErrorBody(res)}`)
    }
    const data = (await res.json()) as DgResponse

    const utts = data.results?.utterances
    if (utts && utts.length > 0) {
      return utts
        .map((u) => ({
          start: u.start,
          end: u.end,
          text: u.transcript.trim(),
          words: u.words?.map(toWord),
        }))
        .filter((u) => u.text.length > 0)
    }

    // Defensive fallback: some configurations may omit utterances.
    const alt = data.results?.channels?.[0]?.alternatives?.[0]
    const words = alt?.words?.map(toWord)
    if (words && words.length > 0) {
      const first = words[0]!
      const last = words[words.length - 1]!
      return [{ start: first.start, end: last.end, text: words.map((w) => w.text).join(' '), words }]
    }
    return []
  },

  async testKey(key: string): Promise<boolean> {
    const res = await fetch(`${API}/projects`, { headers: { Authorization: `Token ${key}` } })
    return res.ok
  },
}

function toWord(w: DgWord): Word {
  return { text: w.punctuated_word ?? w.word, start: w.start, end: w.end }
}
