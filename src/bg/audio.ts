import {
  isMasterPlaylist,
  mimeForPlaylist,
  parseMaster,
  parseMedia,
  pickAudioSource,
  planWindows,
  type MediaPlaylist,
} from '../core/hls'
import { JobError, type AudioPayload } from '../shared/types'
import type { CapturedMedia } from './capture'

const SEGMENT_CONCURRENCY = 4
const MAX_AUDIO_BYTES = 256 * 1024 * 1024

export interface AudioWindow {
  index: number
  total: number
  /** Absolute time offset (seconds) to add to this window's ASR timestamps. */
  startTime: number
  payload: AudioPayload
}

interface HlsPlan {
  playlist: MediaPlaylist
  kind: 'audio' | 'muxed'
  initBytes: Uint8Array | null
}

/**
 * Yield audio in time-ordered windows so the pipeline can transcribe and show
 * captions for the beginning of a long video quickly, and stop early (the job
 * aborts on disconnect) instead of processing all 26 minutes a viewer may
 * never watch. Progressive HLS path; progressive mp4 isn't chunkable, so it
 * yields a single window.
 */
export async function* fetchAudioWindows(
  cap: CapturedMedia,
  windowSec: number,
  signal: AbortSignal,
): AsyncGenerator<AudioWindow> {
  let plan: HlsPlan | null = null
  if (cap.masterUrl) {
    try {
      plan = await resolveHlsPlan(cap.masterUrl, signal)
    } catch (e) {
      // Playlist resolution failed before any window was emitted — fall back
      // to mp4 if we captured one; otherwise surface the error.
      if (signal.aborted || cap.mp4.length === 0) throw e
    }
  }

  if (plan) {
    const { playlist, kind, initBytes } = plan
    const mime = mimeForPlaylist(playlist, kind)
    const windows = planWindows(playlist.segmentDurations, windowSec)
    for (let w = 0; w < windows.length; w++) {
      if (signal.aborted) return
      const win = windows[w]!
      const uris = playlist.segmentUris.slice(win.startIndex, win.endIndex)
      const segBytes = await fetchSegments(uris, signal)
      const payload = concatPayload(initBytes, segBytes, mime)
      yield { index: w, total: windows.length, startTime: win.startTime, payload }
    }
    return
  }

  if (cap.mp4.length > 0) {
    const smallest = [...cap.mp4].sort((a, b) => a.pixels - b.pixels)[0]!
    const bytes = await fetchBytes(smallest.url, signal)
    yield { index: 0, total: 1, startTime: 0, payload: { bytes, mime: 'video/mp4' } }
    return
  }

  throw new JobError('toast_no_media')
}

async function resolveHlsPlan(playlistUrl: string, signal: AbortSignal): Promise<HlsPlan> {
  const masterText = await fetchText(playlistUrl, signal)
  let mediaUrl = playlistUrl
  let kind: 'audio' | 'muxed' = 'muxed'
  let mediaText = masterText
  if (isMasterPlaylist(masterText)) {
    const pick = pickAudioSource(parseMaster(masterText, playlistUrl))
    if (!pick) throw new JobError('err_audio_fetch', 'master playlist has no renditions')
    mediaUrl = pick.uri
    kind = pick.kind
    mediaText = await fetchText(mediaUrl, signal)
  }
  const playlist = parseMedia(mediaText, mediaUrl)
  if (playlist.segmentUris.length === 0) throw new JobError('err_audio_fetch', 'no segments in playlist')
  const initBytes = playlist.initUri ? await fetchBytes(playlist.initUri, signal) : null
  return { playlist, kind, initBytes }
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
