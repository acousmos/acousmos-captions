import { getAsrProvider } from '../core/asr'
import { cacheGet, cachePut } from '../core/cache'
import { buildCues } from '../core/cues'
import { glossaryForDeepgram, glossaryForPrompt, glossaryTerms } from '../shared/glossary'
import { getTranslateProvider, translateCues } from '../core/translate'
import type { JobEvent, JobRequest } from '../shared/messages'
import { asrKeyFor, llmKeyFor, loadSettings } from '../shared/settings'
import { JobError, type CaptionResult, type Cue, type JobPhase, type Utterance } from '../shared/types'
import { fetchAudioWindows } from './audio'
import { lookupMedia } from './capture'
import { jobEnded, jobStarted } from './keepalive'

/** Audio window size (seconds). Smaller = faster first captions, more API
 *  round-trips. ~3 min balances both for typical talk-length videos. */
const WINDOW_SEC = 180

/**
 * One job per (mediaId, targetLang). Multiple ports (e.g. the same video
 * visible in two tabs) attach to the same running job; late joiners receive a
 * snapshot. The job aborts when its last port disconnects.
 */

interface RunningJob {
  ports: Set<chrome.runtime.Port>
  abort: AbortController
  snapshot: { phase: JobPhase; cues: Cue[] }
}

const jobs = new Map<string, RunningJob>()

export function attachPort(port: chrome.runtime.Port, req: JobRequest): void {
  void (async () => {
    const settings = await loadSettings()
    const key = `${req.mediaId}:${settings.llm.targetLang}`

    const existing = jobs.get(key)
    if (existing && !req.force) {
      existing.ports.add(port)
      port.onDisconnect.addListener(() => detach(existing, port, key))
      // Replay current state for the late joiner.
      send(port, { kind: 'job/progress', progress: { phase: existing.snapshot.phase } })
      if (existing.snapshot.cues.length > 0) {
        send(port, { kind: 'job/utterances', cues: existing.snapshot.cues })
      }
      return
    }

    const job: RunningJob = {
      ports: new Set([port]),
      abort: new AbortController(),
      snapshot: { phase: 'queued', cues: [] },
    }
    jobs.set(key, job)
    port.onDisconnect.addListener(() => detach(job, port, key))

    jobStarted()
    try {
      await runJob(req, settings, job, key)
    } catch (e) {
      const ev: JobEvent =
        e instanceof JobError
          ? { kind: 'job/error', errorKey: e.key, detail: e.message }
          : { kind: 'job/error', errorKey: 'err_unknown', detail: e instanceof Error ? e.message : String(e) }
      broadcast(job, ev)
    } finally {
      jobs.delete(key)
      jobEnded()
    }
  })()
}

async function runJob(
  req: JobRequest,
  settings: Awaited<ReturnType<typeof loadSettings>>,
  job: RunningJob,
  _key: string,
): Promise<void> {
  const { mediaId } = req
  const targetLang = settings.llm.targetLang
  const signal = job.abort.signal

  if (!req.force) {
    const cached = await cacheGet(mediaId, targetLang)
    if (cached) {
      job.snapshot = { phase: 'done', cues: cached.cues }
      broadcast(job, { kind: 'job/done', result: cached, fromCache: true })
      return
    }
  }

  const asrKey = asrKeyFor(settings)
  if (!asrKey) throw new JobError('toast_no_asr_key')
  const llmKey = llmKeyFor(settings)
  if (!llmKey) throw new JobError('toast_no_llm_key')

  setPhase(job, 'fetching_audio')
  const captured = await lookupMedia(mediaId)
  if (!captured) throw new JobError('toast_need_play')

  const asr = getAsrProvider(settings.asr.provider)
  const terms =
    settings.asr.provider === 'deepgram'
      ? glossaryForDeepgram(settings.asr.customTerms)
      : glossaryTerms(settings.asr.customTerms)
  const provider = getTranslateProvider(settings.llm.provider)
  const isOpenAi = settings.llm.provider === 'openai'
  const glossary = glossaryForPrompt(settings.asr.customTerms)

  // Process the audio in time windows: transcribe + translate each window and
  // stream its cues so captions for the start of a long video appear within
  // seconds, and the rest fills in (or stops early if the viewer leaves).
  const cues: Cue[] = []
  let firstWindow = true
  for await (const win of fetchAudioWindows(captured, WINDOW_SEC, signal)) {
    if (signal.aborted) return
    if (firstWindow) setPhase(job, 'transcribing')

    const utterances = await asr.transcribe(win.payload, {
      key: asrKey,
      sourceLang: settings.asr.sourceLang,
      terms,
      signal,
    })
    const windowCues = buildCues(offsetUtterances(utterances, win.startTime)).map((c, i) => ({
      ...c,
      id: cues.length + i,
    }))
    cues.push(...windowCues)

    // Source lines render immediately (cumulative); translation patches in.
    job.snapshot = { phase: 'translating', cues }
    broadcast(job, { kind: 'job/utterances', cues })
    if (firstWindow) setPhase(job, 'translating')

    await translateCues(windowCues, provider, {
      key: llmKey,
      model: isOpenAi ? settings.llm.openaiModel : settings.llm.anthropicModel,
      baseUrl: isOpenAi ? settings.llm.openaiBaseUrl : undefined,
      targetLang,
      glossary,
      signal,
      onBatch: (ids, texts) => {
        for (let k = 0; k < ids.length; k++) {
          const cue = cues[ids[k]!]
          if (cue) cue.tgt = texts[k]!
        }
        broadcast(job, { kind: 'job/translated', ids, texts })
      },
    })

    firstWindow = false
    broadcast(job, {
      kind: 'job/progress',
      progress: { phase: 'translating', ratio: (win.index + 1) / win.total },
    })
  }

  if (cues.length === 0) throw new JobError('err_no_speech')

  const result: CaptionResult = {
    mediaId,
    sourceLang: settings.asr.sourceLang,
    targetLang,
    cues,
    createdAt: Date.now(),
    asrProvider: settings.asr.provider,
    llmProvider: settings.llm.provider,
  }
  await cachePut(result)
  job.snapshot = { phase: 'done', cues }
  broadcast(job, { kind: 'job/done', result, fromCache: false })

  if (cues.some((c) => !c.tgt)) {
    // Partial translation is surfaced, not fatal — the UI shows originals.
    broadcast(job, {
      kind: 'job/progress',
      progress: { phase: 'done', errorKey: 'toast_translation_partial' },
    })
  }
}

/** Shift ASR timestamps from window-relative to absolute video time. */
function offsetUtterances(utterances: Utterance[], offset: number): Utterance[] {
  if (offset === 0) return utterances
  return utterances.map((u) => ({
    start: u.start + offset,
    end: u.end + offset,
    text: u.text,
    words: u.words?.map((w) => ({ text: w.text, start: w.start + offset, end: w.end + offset })),
  }))
}

function setPhase(job: RunningJob, phase: JobPhase): void {
  job.snapshot.phase = phase
  broadcast(job, { kind: 'job/progress', progress: { phase } })
}

function broadcast(job: RunningJob, ev: JobEvent): void {
  for (const p of job.ports) send(p, ev)
}

function send(port: chrome.runtime.Port, ev: JobEvent): void {
  try {
    port.postMessage(ev)
  } catch {
    // port already gone
  }
}

function detach(job: RunningJob, port: chrome.runtime.Port, key: string): void {
  job.ports.delete(port)
  if (job.ports.size === 0) {
    job.abort.abort()
    jobs.delete(key)
  }
}
