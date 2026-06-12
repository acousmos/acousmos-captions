/**
 * X (Twitter) media identification.
 *
 * The same numeric media id appears in both the player poster
 * (pbs.twimg.com/{amplify_video_thumb,ext_tw_video_thumb}/<id>/…) and the
 * stream URLs (video.twimg.com/{amplify_video,ext_tw_video}/<id>/…), which is
 * what lets the content script correlate a <video> element with the playlist
 * the background captured. Animated GIFs (tweet_video) have no audio track.
 */

export type PosterInfo = { id: string; kind: 'video' } | { kind: 'gif' }

export function mediaIdFromPoster(posterUrl: string): PosterInfo | null {
  if (!posterUrl) return null
  if (/\/tweet_video_thumb\//.test(posterUrl)) return { kind: 'gif' }
  const m = posterUrl.match(/\/(?:amplify_video_thumb|ext_tw_video_thumb)\/(\d+)\//)
  if (m?.[1]) return { id: m[1], kind: 'video' }
  return null
}

export interface StreamInfo {
  id: string
  type: 'm3u8' | 'mp4'
  url: string
  /** Pixel area parsed from mp4 path, used to pick the smallest variant. */
  pixels?: number
}

export function streamInfoFromUrl(url: string): StreamInfo | null {
  const m = url.match(/video\.twimg\.com\/(?:amplify_video|ext_tw_video)\/(\d+)\//)
  if (!m?.[1]) return null
  const id = m[1]
  const path = url.split('?')[0] ?? url
  if (path.endsWith('.m3u8')) {
    // Only the master playlist (under /pl/) is useful as an entry point;
    // rendition playlists are resolved from it.
    return { id, type: 'm3u8', url }
  }
  if (path.endsWith('.mp4')) {
    const res = path.match(/\/(\d+)x(\d+)\//)
    const pixels = res ? Number(res[1]) * Number(res[2]) : undefined
    return { id, type: 'mp4', url, pixels }
  }
  return null
}

/** Master playlists live under /pl/ on both amplify and ext_tw paths. */
export function isLikelyMasterPlaylist(url: string): boolean {
  const path = url.split('?')[0] ?? url
  return path.endsWith('.m3u8') && /\/pl\//.test(path)
}
