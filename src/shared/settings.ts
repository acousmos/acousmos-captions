import type { AsrProviderId, LlmProviderId } from './types'

export interface Settings {
  asr: {
    provider: AsrProviderId
    deepgramKey: string
    sonioxKey: string
    /** BCP-47-ish code or 'auto'. */
    sourceLang: string
  }
  llm: {
    provider: LlmProviderId
    openaiKey: string
    openaiBaseUrl: string
    openaiModel: string
    anthropicKey: string
    anthropicModel: string
    targetLang: string
  }
  display: {
    enabled: boolean
    srcFirst: boolean
    /** Multiplier applied to the player-width-derived base size. */
    fontScale: number
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
  },
  llm: {
    provider: 'openai',
    openaiKey: '',
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiModel: 'gpt-4.1-mini',
    anthropicKey: '',
    anthropicModel: 'claude-haiku-4-5',
    targetLang: 'zh-CN',
  },
  display: {
    enabled: true,
    srcFirst: true,
    fontScale: 1,
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
  return s.llm.provider === 'openai' ? s.llm.openaiKey : s.llm.anthropicKey
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) {
      cb(mergeSettings(DEFAULT_SETTINGS, changes[KEY].newValue as DeepPartial<Settings>))
    }
  })
}
