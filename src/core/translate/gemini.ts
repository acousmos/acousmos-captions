import { openaiCompat } from './openai'
import type { TranslateProvider } from './types'

// Gemini exposes an OpenAI-compatible Chat Completions surface, so we reuse the
// same request/parse path (including the source-echo prompt and tolerant JSON
// extraction) and just point it at Google's endpoint. The user's key and model
// (e.g. gemini-3.5-flash) come from settings; the base URL is fixed here.
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai'

export const gemini: TranslateProvider = {
  id: 'gemini',
  translateBatch: (items, ctx, opts) => openaiCompat.translateBatch(items, ctx, { ...opts, baseUrl: GEMINI_BASE }),
  testKey: (key, opts) => openaiCompat.testKey(key, { model: opts.model, baseUrl: GEMINI_BASE }),
}
