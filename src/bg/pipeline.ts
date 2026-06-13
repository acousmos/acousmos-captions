import { getAsrProvider } from '../core/asr'
import { cacheGet, cachePut } from '../core/cache'
import { buildCues } from '../core/cues'
import { glossaryForDeepgram, glossaryForPrompt, glossaryTerms } from '../shared/glossary'
import { getTranslateProvider, translateCues } from '../core/translate'
import type { JobEvent, JobRequest } from '../shared/messages'
import { asrKeyFor, llmCacheTag, llmKeyFor, llmModelFor, loadSettings } from '../shared/settings'
import { JobError, type CaptionResult, type Cue, type JobPhase, type Utterance } from '../shared/types'
import { resolveAudioPlans, type AudioPlan } from './audio'
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
    // Same identity as the cache, so a port can't attach to a job that's running
    // under a different translator than the current settings.
    const key = `${req.mediaId}:${settings.llm.targetLang}:${llmCacheTag(settings)}`

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
    const cached = await cacheGet(mediaId, targetLang, llmCacheTag(settings))
    if (cached) {
      job.snapshot = { phase: 'done', cues: cached.cues }
      broadcast(job, { kind: 'job/done', result: cached, fromCache: true })
      return
    }
  }

  const llmKey = llmKeyFor(settings)
  if (!llmKey) throw new JobError('toast_no_llm_key')

  const provider = getTranslateProvider(settings.llm.provider)
  const { llmModel, llmBaseUrl } = resolveLlmTarget(settings)
  const glossary = glossaryForPrompt(settings.asr.customTerms)

  const cues: Cue[] = []

  // Emit a window's cues (cumulative) and translate them in place.
  const processWindow = async (utterances: Utterance[], startTime: number): Promise<void> => {
    const windowCues = buildCues(offsetUtterances(utterances, startTime)).map((c, i) => ({
      ...c,
      id: cues.length + i,
    }))
    cues.push(...windowCues)
    job.snapshot = { phase: 'translating', cues }
    broadcast(job, { kind: 'job/utterances', cues }) // source lines render immediately
    await translateCues(windowCues, provider, {
      key: llmKey,
      model: llmModel,
      baseUrl: llmBaseUrl,
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
  }

  if (req.nativeUtterances && req.nativeUtterances.length > 0) {
    // The video shipped its own subtitle track — translate it directly, no ASR.
    broadcast(job, { kind: 'job/debug', info: `native captions: ${req.nativeUtterances.length} cues` })
    setPhase(job, 'translating')
    await processWindow(req.nativeUtterances, 0)
    broadcast(job, { kind: 'job/progress', progress: { phase: 'translating', ratio: 1 } })
  } else {
    const asrKey = asrKeyFor(settings)
    if (!asrKey) throw new JobError('toast_no_asr_key')

    setPhase(job, 'fetching_audio')
    const captured = await lookupMedia(mediaId)
    if (!captured) throw new JobError('toast_need_play')

    const asr = getAsrProvider(settings.asr.provider)
    const terms =
      settings.asr.provider === 'deepgram'
        ? glossaryForDeepgram(settings.asr.customTerms)
        : glossaryTerms(settings.asr.customTerms)
    const transcribe = (payload: Parameters<typeof asr.transcribe>[0]) =>
      asr.transcribe(payload, { key: asrKey, sourceLang: settings.asr.sourceLang, terms, signal })

    // Pick the first audio source the ASR backend actually accepts (some X
    // renditions don't decode), then process its windows progressively.
    setPhase(job, 'transcribing')
    const plans = await resolveAudioPlans(captured, WINDOW_SEC, signal)
    let active: AudioPlan | null = null
    let firstUtterances: Utterance[] = []
    let lastErr: unknown
    broadcast(job, { kind: 'job/debug', info: `plans: ${plans.map((p) => p.label).join(', ')}` })
    for (const plan of plans) {
      if (signal.aborted) return
      try {
        const payload = await plan.getWindow(0)
        const head = [...payload.bytes.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')
        broadcast(job, {
          kind: 'job/debug',
          info: `try "${plan.label}": ${payload.bytes.length}B ${payload.mime} head=${head}`,
        })
        const utts = await transcribe(payload)
        active = plan
        firstUtterances = utts
        broadcast(job, { kind: 'job/debug', info: `OK "${plan.label}" → ${utts.length} utterances` })
        break
      } catch (e) {
        if (signal.aborted) throw e
        if (e instanceof JobError && e.key === 'err_asr_auth') throw e // a bad key won't improve
        lastErr = e
        broadcast(job, { kind: 'job/debug', info: `rejected "${plan.label}": ${(e as Error).message}` })
        // try the next candidate source
      }
    }
    if (!active) throw lastErr instanceof Error ? lastErr : new JobError('err_audio_fetch')

    setPhase(job, 'translating')
    await processWindow(firstUtterances, active.startTimes[0] ?? 0)
    broadcast(job, { kind: 'job/progress', progress: { phase: 'translating', ratio: 1 / active.total } })

    for (let i = 1; i < active.total; i++) {
      if (signal.aborted) return
      const utts = await transcribe(await active.getWindow(i))
      await processWindow(utts, active.startTimes[i] ?? 0)
      broadcast(job, { kind: 'job/progress', progress: { phase: 'translating', ratio: (i + 1) / active.total } })
    }
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
    llmModel,
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

/** Per-provider model + base URL. Gemini's base URL is fixed inside its provider. */
function resolveLlmTarget(settings: Awaited<ReturnType<typeof loadSettings>>): {
  llmModel: string
  llmBaseUrl: string | undefined
} {
  return {
    llmModel: llmModelFor(settings),
    llmBaseUrl: settings.llm.provider === 'openai' ? settings.llm.openaiBaseUrl : undefined,
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
