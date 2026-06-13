import {
  isMasterPlaylist,
  mimeForPlaylist,
  parseMaster,
  parseMedia,
  planWindows,
  type MediaPlaylist,
  type SegmentWindow,
} from '../core/hls'
import { JobError, type AudioPayload } from '../shared/types'
import type { CapturedMedia } from './capture'

const SEGMENT_CONCURRENCY = 4
const MAX_AUDIO_BYTES = 256 * 1024 * 1024

/**
 * A candidate audio source. The pipeline transcribes window 0 of each plan in
 * preference order until one is accepted by the ASR backend, then uses that
 * plan for the rest of the video. This makes us resilient to a given X
 * rendition the recognizer can't decode: HLS audio-only (smallest) is tried
 * first, then the lowest muxed HLS variant, then the progressive mp4 (which is
 * a standard container the ASR reliably accepts) as a non-chunked safety net.
 */
export interface AudioPlan {
  label: string
  total: number
  /** Absolute time offset (seconds) for each window's ASR timestamps. */
  startTimes: number[]
  getWindow(index: number): Promise<AudioPayload>
}

export async function resolveAudioPlans(
  cap: CapturedMedia,
  windowSec: number,
  signal: AbortSignal,
): Promise<AudioPlan[]> {
  const plans: AudioPlan[] = []

  if (cap.masterUrl) {
    try {
      const masterText = await fetchText(cap.masterUrl, signal)
      if (isMasterPlaylist(masterText)) {
        const master = parseMaster(masterText, cap.masterUrl)
        const audio = master.audio.find((a) => a.isDefault) ?? master.audio[0]
        if (audio) await pushHlsPlan(plans, 'hls-audio', audio.uri, 'audio', windowSec, signal)
        const variant = [...master.variants].sort((a, b) => a.bandwidth - b.bandwidth)[0]
        if (variant) await pushHlsPlan(plans, 'hls-muxed', variant.uri, 'muxed', windowSec, signal)
      } else {
        // The captured URL was already a media playlist.
        await pushHlsPlan(plans, 'hls', cap.masterUrl, 'muxed', windowSec, signal)
      }
    } catch (e) {
      if (signal.aborted) throw e
      // Master fetch/parse failed — rely on the mp4 plan below.
    }
  }

  if (cap.mp4.length > 0) {
    const smallest = [...cap.mp4].sort((a, b) => a.pixels - b.pixels)[0]!
    plans.push({
      label: 'mp4',
      total: 1,
      startTimes: [0],
      getWindow: async () => ({ bytes: await fetchBytes(smallest.url, signal), mime: 'video/mp4' }),
    })
  }

  if (plans.length === 0) throw new JobError('toast_no_media')
  return plans
}

async function pushHlsPlan(
  plans: AudioPlan[],
  label: string,
  mediaUrl: string,
  kind: 'audio' | 'muxed',
  windowSec: number,
  signal: AbortSignal,
): Promise<void> {
  try {
    plans.push(await buildHlsPlan(label, mediaUrl, kind, windowSec, signal))
  } catch (e) {
    if (signal.aborted) throw e
    // Skip this rendition; another plan may still work.
  }
}

async function buildHlsPlan(
  label: string,
  mediaUrl: string,
  kind: 'audio' | 'muxed',
  windowSec: number,
  signal: AbortSignal,
): Promise<AudioPlan> {
  const text = await fetchText(mediaUrl, signal)
  const playlist: MediaPlaylist = parseMedia(text, mediaUrl)
  if (playlist.segmentUris.length === 0) throw new JobError('err_audio_fetch', `${label}: no segments`)
  const initBytes = playlist.initUri ? await fetchBytes(playlist.initUri, signal) : null
  const mime = mimeForPlaylist(playlist, kind)
  const windows: SegmentWindow[] = planWindows(playlist.segmentDurations, windowSec)
  return {
    label,
    total: windows.length,
    startTimes: windows.map((w) => w.startTime),
    getWindow: async (index: number) => {
      const win = windows[index]!
      const segs = await fetchSegments(playlist.segmentUris.slice(win.startIndex, win.endIndex), signal)
      return concatPayload(initBytes, segs, mime)
    },
  }
}

async function fetchSegments(uris: string[], signal: AbortSignal): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = new Array(uris.length)
  let total = 0
  let next = 0
  async function worker(): Promise<void> {
    while (next < uris.length) {
      const idx = next++
      const bytes = await fetchBytes(uris[idx]!, signal)
      parts[idx] = bytes
      total += bytes.byteLength
      if (total > MAX_AUDIO_BYTES) throw new JobError('err_audio_fetch', 'audio exceeds size limit')
    }
  }
  await Promise.all(Array.from({ length: Math.min(SEGMENT_CONCURRENCY, uris.length) }, worker))
  return parts
}

function concatPayload(init: Uint8Array | null, parts: Uint8Array[], mime: string): AudioPayload {
  const all = init ? [init, ...parts] : parts
  const total = all.reduce((n, p) => n + p.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const p of all) {
    bytes.set(p, offset)
    offset += p.byteLength
  }
  return { bytes, mime }
}

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { credentials: 'include', signal })
  if (!res.ok) throw new JobError('err_audio_fetch', `HTTP ${res.status} for ${url.split('?')[0]}`)
  return res.text()
}

async function fetchBytes(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(url, { credentials: 'include', signal })
  if (!res.ok) throw new JobError('err_audio_fetch', `HTTP ${res.status} for ${url.split('?')[0]}`)
  return new Uint8Array(await res.arrayBuffer())
}
