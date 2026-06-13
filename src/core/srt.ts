import type { Cue } from '../shared/types'

export type SrtMode = 'bilingual' | 'source' | 'target'

export function formatSrtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  const frac = ms % 1000
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(frac, 3)}`
}

export function toSrt(cues: Cue[], mode: SrtMode): string {
  const blocks: string[] = []
  let n = 0
  for (const c of cues) {
    const lines: string[] = []
    if (mode === 'bilingual') {
      lines.push(c.src)
      if (c.tgt) lines.push(c.tgt)
    } else if (mode === 'source') {
      lines.push(c.src)
    } else {
      // Target-only export falls back to the original where translation is
      // missing — an untimed gap is worse than a foreign line.
      lines.push(c.tgt ?? c.src)
    }
    const text = lines.join('\n').trim()
    if (!text) continue
    n += 1
    blocks.push(`${n}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${text}`)
  }
  return blocks.join('\n\n') + '\n'
}

export function srtFilename(mediaId: string, mode: SrtMode, targetLang: string, engine?: string): string {
  const suffix = mode === 'bilingual' ? `bi-${targetLang}` : mode === 'source' ? 'orig' : targetLang
  // Tag the file with the translator (e.g. gemini-3.5-flash) so exports from
  // different engines are distinguishable when comparing them.
  const tag = engine ? `.${engine.replace(/[^a-z0-9.-]+/gi, '-')}` : ''
  return `x-video-${mediaId}.${suffix}${tag}.srt`
}
