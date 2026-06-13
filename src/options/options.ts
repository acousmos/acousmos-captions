import { deepgram } from '../core/asr/deepgram'
import { soniox } from '../core/asr/soniox'
import { anthropic } from '../core/translate/anthropic'
import { normalizeBase, openaiCompat } from '../core/translate/openai'
import { cacheClear } from '../core/cache'
import { t } from '../shared/i18n'
import { loadSettings, saveSettings, type Settings } from '../shared/settings'

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

// Apply i18n to static markup.
for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
  el.textContent = t(el.dataset['i18n']!)
}
for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-ph]')) {
  ;(el as HTMLInputElement | HTMLTextAreaElement).placeholder = t(el.dataset['i18nPh']!)
}
$('version').textContent = `v${chrome.runtime.getManifest().version}`

let settings: Settings

const els = {
  asrProvider: $<HTMLSelectElement>('asr-provider'),
  deepgramKey: $<HTMLInputElement>('deepgram-key'),
  sonioxKey: $<HTMLInputElement>('soniox-key'),
  sourceLang: $<HTMLSelectElement>('source-lang'),
  customTerms: $<HTMLTextAreaElement>('custom-terms'),
  llmProvider: $<HTMLSelectElement>('llm-provider'),
  openaiBase: $<HTMLInputElement>('openai-base'),
  openaiModel: $<HTMLInputElement>('openai-model'),
  openaiKey: $<HTMLInputElement>('openai-key'),
  anthropicModel: $<HTMLInputElement>('anthropic-model'),
  anthropicKey: $<HTMLInputElement>('anthropic-key'),
  targetLang: $<HTMLSelectElement>('target-lang'),
  mode: $<HTMLSelectElement>('mode'),
  placement: $<HTMLSelectElement>('placement'),
  order: $<HTMLSelectElement>('order'),
  fontScale: $<HTMLInputElement>('font-scale'),
  bgOpacity: $<HTMLInputElement>('bg-opacity'),
  status: $('status'),
}

void loadSettings().then((s) => {
  settings = s
  els.asrProvider.value = s.asr.provider
  els.deepgramKey.value = s.asr.deepgramKey
  els.sonioxKey.value = s.asr.sonioxKey
  els.sourceLang.value = s.asr.sourceLang
  els.customTerms.value = s.asr.customTerms
  els.llmProvider.value = s.llm.provider
  els.openaiBase.value = s.llm.openaiBaseUrl
  els.openaiModel.value = s.llm.openaiModel
  els.openaiKey.value = s.llm.openaiKey
  els.anthropicModel.value = s.llm.anthropicModel
  els.anthropicKey.value = s.llm.anthropicKey
  els.targetLang.value = s.llm.targetLang
  els.mode.value = s.display.mode
  els.placement.value = s.display.placement
  els.order.value = s.display.srcFirst ? 'src' : 'tgt'
  els.fontScale.value = String(s.display.fontScale)
  els.bgOpacity.value = String(s.display.bgOpacity)
  syncVisibility()
  syncRangeLabels()
  void syncGrantRow()
})

let saveTimer: ReturnType<typeof setTimeout> | undefined

function collect(): Settings {
  return {
    asr: {
      provider: els.asrProvider.value as Settings['asr']['provider'],
      deepgramKey: els.deepgramKey.value.trim(),
      sonioxKey: els.sonioxKey.value.trim(),
      sourceLang: els.sourceLang.value,
      customTerms: els.customTerms.value,
    },
    llm: {
      provider: els.llmProvider.value as Settings['llm']['provider'],
      openaiKey: els.openaiKey.value.trim(),
      openaiBaseUrl: els.openaiBase.value.trim() || 'https://api.openai.com/v1',
      openaiModel: els.openaiModel.value.trim() || 'gpt-4.1-mini',
      anthropicKey: els.anthropicKey.value.trim(),
      anthropicModel: els.anthropicModel.value.trim() || 'claude-haiku-4-5',
      targetLang: els.targetLang.value,
    },
    display: {
      enabled: settings.display.enabled,
      mode: els.mode.value as Settings['display']['mode'],
      placement: els.placement.value as Settings['display']['placement'],
      srcFirst: els.order.value === 'src',
      fontScale: Number(els.fontScale.value),
      bgOpacity: Number(els.bgOpacity.value),
    },
  }
}

function scheduleSave(): void {
  syncVisibility()
  syncRangeLabels()
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    settings = collect()
    void saveSettings(settings).then(() => flash(t('opt_saved'), 'ok'))
    void syncGrantRow()
  }, 400)
}

document.addEventListener('input', scheduleSave)
document.addEventListener('change', scheduleSave)

function syncVisibility(): void {
  const asr = els.asrProvider.value
  $('row-deepgram-key').classList.toggle('hidden', asr !== 'deepgram')
  $('row-soniox-key').classList.toggle('hidden', asr !== 'soniox')
  const llm = els.llmProvider.value
  $('openai-fields').classList.toggle('hidden', llm !== 'openai')
  $('anthropic-fields').classList.toggle('hidden', llm !== 'anthropic')
}

function syncRangeLabels(): void {
  $('font-scale-val').textContent = `${Math.round(Number(els.fontScale.value) * 100)}%`
  $('bg-opacity-val').textContent = `${Math.round(Number(els.bgOpacity.value) * 100)}%`
}

/** Custom OpenAI-compatible hosts need an optional host permission grant. */
async function syncGrantRow(): Promise<void> {
  const row = $('row-grant')
  try {
    const origin = `${new URL(normalizeBase(els.openaiBase.value)).origin}/*`
    const granted = await chrome.permissions.contains({ origins: [origin] })
    row.classList.toggle('hidden', granted)
  } catch {
    row.classList.add('hidden')
  }
}

$('grant-origin').addEventListener('click', () => {
  void (async () => {
    try {
      const origin = `${new URL(normalizeBase(els.openaiBase.value)).origin}/*`
      await chrome.permissions.request({ origins: [origin] })
    } catch {
      // invalid URL — ignore
    }
    void syncGrantRow()
  })()
})

function bindTest(buttonId: string, fn: () => Promise<boolean>): void {
  const btn = $<HTMLButtonElement>(buttonId)
  btn.addEventListener('click', () => {
    void (async () => {
      btn.disabled = true
      try {
        const ok = await fn()
        flash(ok ? t('opt_key_ok') : t('opt_key_fail'), ok ? 'ok' : 'fail')
      } catch {
        flash(t('opt_key_fail'), 'fail')
      } finally {
        btn.disabled = false
      }
    })()
  })
}

bindTest('test-deepgram', () => deepgram.testKey(els.deepgramKey.value.trim()))
bindTest('test-soniox', () => soniox.testKey(els.sonioxKey.value.trim()))
bindTest('test-openai', () =>
  openaiCompat.testKey(els.openaiKey.value.trim(), {
    model: els.openaiModel.value.trim(),
    baseUrl: els.openaiBase.value.trim(),
  }),
)
bindTest('test-anthropic', () =>
  anthropic.testKey(els.anthropicKey.value.trim(), { model: els.anthropicModel.value.trim() }),
)

$('clear-cache').addEventListener('click', () => {
  void cacheClear().then(() => flash(t('opt_cache_cleared'), 'ok'))
})

let flashTimer: ReturnType<typeof setTimeout> | undefined
function flash(text: string, cls: 'ok' | 'fail'): void {
  els.status.textContent = text
  els.status.className = cls
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    els.status.textContent = ''
    els.status.className = ''
  }, 2200)
}
