import type { BatchItem, TranslateContext } from './types'

export function systemPrompt(targetLang: string, glossary = ''): string {
  const lines = [
    `You are a professional subtitle translator. Translate each numbered subtitle segment into ${targetLang}.`,
    'Rules:',
    '- Translate naturally and idiomatically; subtitles are read while watching, so keep lines tight.',
    '- Keep proper nouns, product names, and technical terms recognizable (translate or keep English, whichever a native reader expects).',
    '- Segments are fragments of continuous speech; use the provided context for pronouns and continuity.',
    '- ASR may mishear technical names; correct obvious mistakes using the glossary below before translating.',
    '- Output JSON only: {"items":[{"i":<id>,"t":"<translation>"}, ...]}.',
    '- Exactly one output item per input id. Never merge, split, reorder, omit, or invent ids.',
    '- No explanations, no markdown fences.',
  ]
  if (glossary) lines.push(`Glossary (canonical spellings of likely terms): ${glossary}`)
  return lines.join('\n')
}

export function userPrompt(items: BatchItem[], ctx: TranslateContext): string {
  const payload: Record<string, unknown> = { segments: items }
  if (ctx.prevSource.length > 0) payload['previous_lines_context'] = ctx.prevSource
  return JSON.stringify(payload)
}

/** JSON Schema for Anthropic structured outputs (and documentation of shape). */
export const ITEMS_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          t: { type: 'string' },
        },
        required: ['i', 't'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const

/**
 * Tolerant extraction of {items:[{i,t}]} (or a bare array) from LLM text.
 * Returns only well-formed entries; the caller decides how to handle gaps.
 */
export function extractItems(text: string): BatchItem[] {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = findJsonStart(cleaned)
  if (start === -1) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned.slice(start))
  } catch {
    // Try to salvage by trimming trailing junk after the last } or ].
    const lastBrace = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'))
    if (lastBrace <= start) return []
    try {
      parsed = JSON.parse(cleaned.slice(start, lastBrace + 1))
    } catch {
      return []
    }
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : []
  const out: BatchItem[] = []
  for (const entry of arr) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      Number.isInteger((entry as BatchItem).i) &&
      typeof (entry as BatchItem).t === 'string'
    ) {
      out.push({ i: (entry as BatchItem).i, t: (entry as BatchItem).t.trim() })
    }
  }
  return out
}

function findJsonStart(s: string): number {
  const obj = s.indexOf('{')
  const arr = s.indexOf('[')
  if (obj === -1) return arr
  if (arr === -1) return obj
  return Math.min(obj, arr)
}
