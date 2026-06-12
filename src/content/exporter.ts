import { srtFilename, toSrt, type SrtMode } from '../core/srt'
import type { Cue } from '../shared/types'

export function downloadSrt(cues: Cue[], mode: SrtMode, mediaId: string, targetLang: string): void {
  const blob = new Blob([toSrt(cues, mode)], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = srtFilename(mediaId, mode, targetLang)
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    a.remove()
    URL.revokeObjectURL(url)
  }, 1000)
}
