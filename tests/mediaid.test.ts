import { describe, expect, it } from 'vitest'
import { isLikelyMasterPlaylist, mediaIdFromPoster, streamInfoFromUrl } from '../src/core/mediaid'

describe('mediaIdFromPoster', () => {
  it('extracts id from amplify_video_thumb posters', () => {
    expect(
      mediaIdFromPoster('https://pbs.twimg.com/amplify_video_thumb/1799887766554433221/img/AbCdEf.jpg'),
    ).toEqual({ id: '1799887766554433221', kind: 'video' })
  })

  it('extracts id from ext_tw_video_thumb posters', () => {
    expect(
      mediaIdFromPoster('https://pbs.twimg.com/ext_tw_video_thumb/1234567890123/pu/img/xx.jpg'),
    ).toEqual({ id: '1234567890123', kind: 'video' })
  })

  it('flags GIF thumbnails (no audio)', () => {
    expect(mediaIdFromPoster('https://pbs.twimg.com/tweet_video_thumb/AbCd123.jpg')).toEqual({ kind: 'gif' })
  })

  it('returns null for normal images and empty input', () => {
    expect(mediaIdFromPoster('https://pbs.twimg.com/media/AbCd123.jpg')).toBeNull()
    expect(mediaIdFromPoster('')).toBeNull()
  })
})

describe('streamInfoFromUrl', () => {
  it('parses master playlist URLs', () => {
    const u = 'https://video.twimg.com/amplify_video/1799887766554433221/pl/abc.m3u8?tag=14'
    expect(streamInfoFromUrl(u)).toEqual({ id: '1799887766554433221', type: 'm3u8', url: u })
    expect(isLikelyMasterPlaylist(u)).toBe(true)
  })

  it('parses ext_tw_video playlist URLs', () => {
    const u = 'https://video.twimg.com/ext_tw_video/123/pu/pl/xyz.m3u8'
    expect(streamInfoFromUrl(u)?.id).toBe('123')
    expect(isLikelyMasterPlaylist(u)).toBe(true)
  })

  it('treats rendition playlists as non-master', () => {
    expect(isLikelyMasterPlaylist('https://video.twimg.com/amplify_video/123/aud/32000.m3u8')).toBe(false)
  })

  it('parses mp4 variants with pixel area', () => {
    const info = streamInfoFromUrl('https://video.twimg.com/amplify_video/99/vid/avc1/640x360/file.mp4?tag=1')
    expect(info).toMatchObject({ id: '99', type: 'mp4', pixels: 640 * 360 })
  })

  it('ignores unrelated hosts', () => {
    expect(streamInfoFromUrl('https://example.com/amplify_video/1/pl/a.m3u8')).toBeNull()
  })
})
