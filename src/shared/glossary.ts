/**
 * Built-in glossary of AI / tech proper nouns that ASR models frequently
 * mishear (e.g. "Claude Code" → "cloud code", "Anthropic" → "anthropic").
 * Fed to the ASR layer (Soniox `context.terms`, Deepgram `keyterm`) and to the
 * translation prompt so both stages know the intended spelling.
 *
 * Keep this focused: Deepgram caps keyterms at ~500 tokens, so prioritize the
 * terms most likely to appear in the videos this tool targets (AI/dev talks).
 */
export const BUILTIN_TERMS: readonly string[] = [
  // Anthropic / Claude
  'Anthropic',
  'Claude',
  'Claude Code',
  'Claude Opus',
  'Claude Sonnet',
  'Claude Haiku',
  'MCP',
  'Model Context Protocol',
  'CLAUDE.md',
  'Artifacts',
  // OpenAI
  'OpenAI',
  'ChatGPT',
  'GPT-4',
  'GPT-4o',
  'Codex',
  'Sora',
  // Google
  'Gemini',
  'Google Cloud',
  'Vertex AI',
  'DeepMind',
  'Gemma',
  // Other labs / models
  'Llama',
  'Mistral',
  'Hugging Face',
  'Grok',
  'xAI',
  'Perplexity',
  'Midjourney',
  'Stable Diffusion',
  'DeepSeek',
  'Qwen',
  // Dev / infra
  'GitHub',
  'GitHub Copilot',
  'Copilot',
  'Cursor',
  'VS Code',
  'Visual Studio Code',
  'TypeScript',
  'JavaScript',
  'Python',
  'Rust',
  'Kubernetes',
  'Docker',
  'Cloudflare',
  'Vercel',
  'Supabase',
  'PostgreSQL',
  'Redis',
  'Next.js',
  'React',
  'Node.js',
  // AI concepts
  'LLM',
  'RAG',
  'embedding',
  'embeddings',
  'fine-tuning',
  'prompt engineering',
  'agentic',
  'tokenizer',
  'inference',
  'API',
  'SDK',
  'webhook',
  // Product / feature names that should stay in English (kept recognizable)
  'Computer Use',
  'Core Web Vitals',
  'Web Vitals',
  'Chrome DevTools',
  'DevTools',
]

/**
 * Target-specific forced translations applied by default ("always render X as
 * Y"), so common AI terms come out consistent out of the box. These are
 * language-specific (智能体 only makes sense for Chinese), so they only apply
 * when the target language matches. Users can override any of these, or add
 * their own, via the editable glossary (`term=译法`).
 */
const BUILTIN_MAPPINGS: readonly { lang: string; pairs: Readonly<Record<string, string>> }[] = [
  { lang: 'zh', pairs: { agent: '智能体', agents: '智能体', 'sub-agent': '子智能体', subagent: '子智能体', skill: '技能' } },
]

/** One glossary entry: a source term, optionally with a forced translation. */
interface GlossaryEntry {
  term: string
  translation?: string
}

/** Parse `term` (keep as written) and `term=译法` (force translation) entries. */
function parseEntries(raw: string): GlossaryEntry[] {
  const out: GlossaryEntry[] = []
  for (const piece of raw.split(/[\n,]/)) {
    const s = piece.trim()
    if (!s) continue
    const eq = s.indexOf('=')
    if (eq > 0) {
      const term = s.slice(0, eq).trim()
      const translation = s.slice(eq + 1).trim()
      if (term) out.push(translation ? { term, translation } : { term })
    } else {
      out.push({ term: s })
    }
  }
  return out
}

function builtinMappingsFor(targetLang: string): GlossaryEntry[] {
  const lang = targetLang.toLowerCase()
  const match = BUILTIN_MAPPINGS.find((b) => lang.startsWith(b.lang))
  return match ? Object.entries(match.pairs).map(([term, translation]) => ({ term, translation })) : []
}

/** De-duplicate by term (case-insensitive); earlier entries win. */
function dedupe(entries: GlossaryEntry[]): GlossaryEntry[] {
  const seen = new Set<string>()
  const out: GlossaryEntry[] = []
  for (const e of entries) {
    const key = e.term.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(e)
    }
  }
  return out
}

/**
 * Source spellings only (translations stripped), for the ASR layer which just
 * needs the term to recognize. User terms first, then built-ins.
 */
export function glossaryTerms(customRaw: string): string[] {
  return dedupe([...parseEntries(customRaw), ...BUILTIN_TERMS.map((term) => ({ term }))]).map((e) => e.term)
}

/**
 * Deepgram keyterms are capped at ~500 tokens total; trim to a safe count and
 * keep user terms first.
 */
export function glossaryForDeepgram(customRaw: string, max = 80): string[] {
  return glossaryTerms(customRaw).slice(0, max)
}

/**
 * Glossary string for the translation prompt: a "keep in English" list plus an
 * "always render X→Y" list. User entries (which may include `term=译法`) come
 * first and can override the target-specific built-in mappings; capped so it
 * never dominates the prompt. Returns '' when empty.
 */
export function glossaryForPrompt(customRaw: string, targetLang: string, max = 60): string {
  const entries = dedupe([
    ...parseEntries(customRaw), // user — highest priority, can override built-ins
    ...builtinMappingsFor(targetLang), // target-specific forced translations
    ...BUILTIN_TERMS.map((term) => ({ term })), // keep-in-English names
  ]).slice(0, max)
  const mappings = entries.filter((e) => e.translation).map((e) => `${e.term}→${e.translation!}`)
  const keep = entries.filter((e) => !e.translation).map((e) => e.term)
  const parts: string[] = []
  if (mappings.length) parts.push(`always render: ${mappings.join(', ')}`)
  if (keep.length) parts.push(`keep in English: ${keep.join(', ')}`)
  return parts.join(' | ')
}
