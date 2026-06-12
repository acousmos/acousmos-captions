import { getAsrProvider } from '../core/asr'
import { cacheGet, cachePut } from '../core/cache'
import { buildCues } from '../core/cues'
import { getTranslateProvider, translateCues } from '../core/translate'
import type { JobEvent, JobRequest } from '../shared/messages'
import { asrKeyFor, llmKeyFor, loadSettings } from '../shared/settings'
import { JobError, type CaptionResult, type Cue, type JobPhase } from '../shared/types'
import { fetchAudio } from './audio'
import { lookupMedia } from './capture'
import { jobEnded, jobStarted } from './keepalive'

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

  // 1) Audio
  setPhase(job, 'fetching_audio')
  const captured = await lookupMedia(mediaId)
  if (!captured) throw new JobError('toast_need_play')
  const audio = await fetchAudio(captured, signal)

  // 2) ASR
  setPhase(job, 'transcribing')
  const asr = getAsrProvider(settings.asr.provider)
  const utterances = await asr.transcribe(audio, {
    key: asrKey,
    sourceLang: settings.asr.sourceLang,
    signal,
  })
  if (utterances.length === 0) throw new JobError('err_no_speech')

  // 3) Cues — source lines render immediately, translation patches in.
  const cues = buildCues(utterances)
  job.snapshot = { phase: 'translating', cues }
  broadcast(job, { kind: 'job/utterances', cues })
  setPhase(job, 'translating')

  // 4) Translation
  const provider = getTranslateProvider(settings.llm.provider)
  const isOpenAi = settings.llm.provider === 'openai'
  const translated = await translateCues(cues, provider, {
    key: llmKey,
    model: isOpenAi ? settings.llm.openaiModel : settings.llm.anthropicModel,
    baseUrl: isOpenAi ? settings.llm.openaiBaseUrl : undefined,
    targetLang,
    signal,
    onBatch: (ids, texts) => {
      for (let k = 0; k < ids.length; k++) {
        const cue = cues[ids[k]!]
        if (cue) cue.tgt = texts[k]!
      }
      broadcast(job, { kind: 'job/translated', ids, texts })
    },
  })

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

  if (translated.size < cues.length) {
    // Partial translation is surfaced, not fatal — the UI shows originals.
    broadcast(job, {
      kind: 'job/progress',
      progress: { phase: 'done', errorKey: 'toast_translation_partial' },
    })
  }
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
