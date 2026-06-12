import { isMasterPlaylist, mimeForPlaylist, parseMaster, parseMedia, pickAudioSource } from '../core/hls'
import { JobError, type AudioPayload } from '../shared/types'
import type { CapturedMedia } from './capture'

const SEGMENT_CONCURRENCY = 4
const MAX_AUDIO_BYTES = 256 * 1024 * 1024

/**
 * Assemble the audio payload for a captured media entry. Preference order:
 * HLS audio-only rendition (smallest, exactly what ASR needs) → lowest muxed
 * HLS variant → smallest progressive mp4.
 */
export async function fetchAudio(cap: CapturedMedia, signal: AbortSignal): Promise<AudioPayload> {
  if (cap.masterUrl) {
    try {
      return await fetchFromHls(cap.masterUrl, signal)
    } catch (e) {
      if (signal.aborted || cap.mp4.length === 0) throw e
      // fall through to mp4
    }
  }
  if (cap.mp4.length > 0) {
    const smallest = [...cap.mp4].sort((a, b) => a.pixels - b.pixels)[0]!
    const bytes = await fetchBytes(smallest.url, signal)
    return { bytes, mime: 'video/mp4' }
  }
  throw new JobError('toast_no_media')
}

async function fetchFromHls(playlistUrl: string, signal: AbortSignal): Promise<AudioPayload> {
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

  const uris = playlist.initUri ? [playlist.initUri, ...playlist.segmentUris] : playlist.segmentUris
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

  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return { bytes: out, mime: mimeForPlaylist(playlist, kind) }
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
