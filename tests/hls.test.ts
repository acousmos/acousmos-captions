import { describe, expect, it } from 'vitest'
import {
  isMasterPlaylist,
  mimeForPlaylist,
  parseAttributes,
  parseMaster,
  parseMedia,
  pickAudioSource,
  planWindows,
} from '../src/core/hls'

const BASE = 'https://video.twimg.com/amplify_video/123/pl/master.m3u8?tag=14'

const MASTER = `#EXTM3U
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:NAME="Audio",TYPE=AUDIO,GROUP-ID="audio-32000",DEFAULT=YES,URI="/amplify_video/123/pl/audio/32000.m3u8"
#EXT-X-MEDIA:NAME="Audio",TYPE=AUDIO,GROUP-ID="audio-64000",URI="/amplify_video/123/pl/audio/64000.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=256000,RESOLUTION=320x568,CODECS="avc1.4d001f,mp4a.40.2",AUDIO="audio-32000"
/amplify_video/123/pl/avc1/320x568.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=950000,RESOLUTION=720x1280,CODECS="avc1.640020,mp4a.40.2",AUDIO="audio-64000"
/amplify_video/123/pl/avc1/720x1280.m3u8
`

const MEDIA_FMP4 = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="/amplify_video/123/aud/init.mp4"
#EXTINF:3.97,
/amplify_video/123/aud/seg0.m4s
#EXTINF:4.0,
/amplify_video/123/aud/seg1.m4s
#EXT-X-ENDLIST
`

describe('parseAttributes', () => {
  it('handles quoted values containing commas', () => {
    const a = parseAttributes('BANDWIDTH=950000,CODECS="avc1.640020,mp4a.40.2",AUDIO="g"')
    expect(a['BANDWIDTH']).toBe('950000')
    expect(a['CODECS']).toBe('avc1.640020,mp4a.40.2')
    expect(a['AUDIO']).toBe('g')
  })
})

describe('parseMaster', () => {
  it('extracts audio renditions and variants with resolved URLs', () => {
    const m = parseMaster(MASTER, BASE)
    expect(m.audio).toHaveLength(2)
    expect(m.audio[0]).toMatchObject({
      groupId: 'audio-32000',
      isDefault: true,
      uri: 'https://video.twimg.com/amplify_video/123/pl/audio/32000.m3u8',
    })
    expect(m.variants).toHaveLength(2)
    expect(m.variants[0]?.bandwidth).toBe(256000)
    expect(m.variants[1]?.audioGroup).toBe('audio-64000')
    expect(isMasterPlaylist(MASTER)).toBe(true)
  })
})

describe('pickAudioSource', () => {
  it('prefers the default audio rendition', () => {
    const pick = pickAudioSource(parseMaster(MASTER, BASE))
    expect(pick).toEqual({
      uri: 'https://video.twimg.com/amplify_video/123/pl/audio/32000.m3u8',
      kind: 'audio',
    })
  })

  it('falls back to the lowest-bandwidth muxed variant', () => {
    const noAudio = MASTER.split('\n').filter((l) => !l.startsWith('#EXT-X-MEDIA')).join('\n')
    const pick = pickAudioSource(parseMaster(noAudio, BASE))
    expect(pick?.kind).toBe('muxed')
    expect(pick?.uri).toContain('320x568')
  })

  it('returns null on empty playlists', () => {
    expect(pickAudioSource({ audio: [], variants: [] })).toBeNull()
  })
})

describe('parseMedia', () => {
  it('extracts init segment, media segments and per-segment durations', () => {
    const media = parseMedia(MEDIA_FMP4, BASE)
    expect(media.initUri).toBe('https://video.twimg.com/amplify_video/123/aud/init.mp4')
    expect(media.segmentUris).toEqual([
      'https://video.twimg.com/amplify_video/123/aud/seg0.m4s',
      'https://video.twimg.com/amplify_video/123/aud/seg1.m4s',
    ])
    expect(media.segmentDurations).toEqual([3.97, 4.0])
    expect(media.totalDuration).toBeCloseTo(7.97)
    expect(isMasterPlaylist(MEDIA_FMP4)).toBe(false)
  })

  it('maps container to MIME', () => {
    const media = parseMedia(MEDIA_FMP4, BASE)
    expect(mimeForPlaylist(media, 'audio')).toBe('audio/mp4')
    expect(
      mimeForPlaylist({ segmentUris: ['a/0.ts'], segmentDurations: [1], totalDuration: 1 }, 'muxed'),
    ).toBe('video/mp2t')
  })
})

describe('planWindows', () => {
  it('groups segments into >= windowSec windows with correct start times', () => {
    // 10 segments of 4s = 40s total; 12s windows.
    const durations = Array.from({ length: 10 }, () => 4)
    const windows = planWindows(durations, 12)
    // 3 segments (12s) per window -> [0,3) [3,6) [6,9), then remainder [9,10).
    expect(windows).toEqual([
      { startIndex: 0, endIndex: 3, startTime: 0 },
      { startIndex: 3, endIndex: 6, startTime: 12 },
      { startIndex: 6, endIndex: 9, startTime: 24 },
      { startIndex: 9, endIndex: 10, startTime: 36 },
    ])
  })

  it('returns a single window when total is under windowSec', () => {
    expect(planWindows([4, 4, 4], 60)).toEqual([{ startIndex: 0, endIndex: 3, startTime: 0 }])
  })

  it('covers every segment exactly once with contiguous start times', () => {
    const durations = [5, 5, 5, 5, 5, 5, 5]
    const windows = planWindows(durations, 10)
    expect(windows[0]!.startIndex).toBe(0)
    expect(windows[windows.length - 1]!.endIndex).toBe(durations.length)
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]!.startIndex).toBe(windows[i - 1]!.endIndex)
    }
  })

  it('handles empty input', () => {
    expect(planWindows([], 60)).toEqual([])
  })
})
