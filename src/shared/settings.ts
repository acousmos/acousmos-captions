import { glossaryForPrompt } from './glossary'
import type { AsrProviderId, LlmProviderId } from './types'

export interface Settings {
  asr: {
    provider: AsrProviderId
    deepgramKey: string
    sonioxKey: string
    /** BCP-47-ish code or 'auto'. */
    sourceLang: string
    /** User-added glossary terms (comma/newline separated), on top of built-ins. */
    customTerms: string
  }
  llm: {
    provider: LlmProviderId
    openaiKey: string
    openaiBaseUrl: string
    openaiModel: string
    anthropicKey: string
    anthropicModel: string
    geminiKey: string
    geminiModel: string
    targetLang: string
  }
  display: {
    enabled: boolean
    /** Which lines to render. */
    mode: 'bilingual' | 'source' | 'target'
    srcFirst: boolean
    /** Per-language size multipliers on the player-width-derived base size. */
    srcScale: number
    tgtScale: number
    /** 0..1 */
    bgOpacity: number
  }
}

export const DEFAULT_SETTINGS: Settings = {
  asr: {
    provider: 'deepgram',
    deepgramKey: '',
    sonioxKey: '',
    sourceLang: 'auto',
    customTerms: '',
  },
  llm: {
    provider: 'openai',
    openaiKey: '',
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiModel: 'gpt-4.1-mini',
    anthropicKey: '',
    anthropicModel: 'claude-haiku-4-5',
    geminiKey: '',
    geminiModel: 'gemini-3.5-flash',
    targetLang: 'zh-CN',
  },
  display: {
    enabled: true,
    mode: 'bilingual',
    srcFirst: true,
    srcScale: 0.7,
    tgtScale: 0.85,
    bgOpacity: 0.55,
  },
}

const KEY = 'settings:v1'

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

export function mergeSettings(base: Settings, patch: DeepPartial<Settings> | undefined): Settings {
  if (!patch) return structuredClone(base)
  const out = structuredClone(base)
  for (const section of Object.keys(out) as (keyof Settings)[]) {
    const p = patch[section]
    if (!p) continue
    Object.assign(out[section], Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)))
  }
  return out
}

/** Keys live in storage.local only — never storage.sync (no key syncing). */
export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(KEY)
  return mergeSettings(DEFAULT_SETTINGS, raw[KEY] as DeepPartial<Settings> | undefined)
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: s })
}

export function asrKeyFor(s: Settings): string {
  return s.asr.provider === 'deepgram' ? s.asr.deepgramKey : s.asr.sonioxKey
}

export function llmKeyFor(s: Settings): string {
  switch (s.llm.provider) {
    case 'openai':
      return s.llm.openaiKey
    case 'gemini':
      return s.llm.geminiKey
    case 'anthropic':
      return s.llm.anthropicKey
  }
}

export function llmModelFor(s: Settings): string {
  switch (s.llm.provider) {
    case 'openai':
      return s.llm.openaiModel
    case 'gemini':
      return s.llm.geminiModel
    case 'anthropic':
      return s.llm.anthropicModel
  }
}

/** Identifies which engine produced a cached result, so switching provider/model
 *  re-translates (and keeps each variant cached separately for comparison). For
 *  the OpenAI-compatible provider the base URL is part of the identity too — the
 *  same model id at a different endpoint (OpenAI vs DeepSeek vs a local server)
 *  is a different engine. */
export function llmCacheTag(s: Settings): string {
  const model = llmModelFor(s)
  if (s.llm.provider === 'openai') {
    const base = s.llm.openaiBaseUrl.trim().replace(/\/+$/, '')
    return `openai@${model}@${base}`
  }
  return `${s.llm.provider}@${model}`
}

/** FNV-1a → base36, a small stable string fingerprint (no crypto needed). */
function fingerprint(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * Full cache/job identity: the engine PLUS a fingerprint of the exact glossary
 * sent to the model (built-in terms + target mappings + the user's edits). So
 * editing the glossary — or shipping an updated built-in glossary — produces a
 * different identity and re-translates, instead of serving a stale result.
 */
export function cacheIdentity(s: Settings): string {
  return `${llmCacheTag(s)}#g${fingerprint(glossaryForPrompt(s.asr.customTerms, s.llm.targetLang))}`
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) {
      cb(mergeSettings(DEFAULT_SETTINGS, changes[KEY].newValue as DeepPartial<Settings>))
    }
  })
}
