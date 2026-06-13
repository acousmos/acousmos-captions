import { JobError } from '../../shared/types'
import { fetchRetry, readErrorBody } from '../../shared/net'
import { extractItems, systemPrompt, userPrompt } from './prompt'
import type { BatchItem, TranslateContext, TranslateOptions, TranslateProvider } from './types'

const DEFAULT_BASE = 'https://api.openai.com/v1'

interface ChatResponse {
  choices?: { message?: { content?: string } }[]
}

/** OpenAI-compatible chat completions — covers OpenAI, DeepSeek, Groq, local servers. */
export const openaiCompat: TranslateProvider = {
  id: 'openai',

  async translateBatch(
    items: BatchItem[],
    ctx: TranslateContext,
    opts: TranslateOptions,
  ): Promise<BatchItem[]> {
    const base = normalizeBase(opts.baseUrl)
    const res = await fetchRetry(
      `${base}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: opts.model,
          messages: [
            { role: 'system', content: systemPrompt(ctx.targetLang, ctx.glossary) },
            { role: 'user', content: userPrompt(items, ctx) },
          ],
        }),
      },
      { signal: opts.signal, timeoutMs: 120_000 },
    )
    if (res.status === 401 || res.status === 403) throw new JobError('err_llm_auth', await readErrorBody(res))
    if (!res.ok) throw new JobError('err_llm_failed', `LLM HTTP ${res.status}: ${await readErrorBody(res)}`)
    const data = (await res.json()) as ChatResponse
    const text = data.choices?.[0]?.message?.content ?? ''
    return extractItems(text)
  },

  async testKey(key: string, opts: { baseUrl?: string }): Promise<boolean> {
    const base = normalizeBase(opts.baseUrl)
    const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } })
    return res.ok
  },
}

export function normalizeBase(baseUrl: string | undefined): string {
  const base = (baseUrl ?? DEFAULT_BASE).trim().replace(/\/+$/, '')
  return base || DEFAULT_BASE
}
