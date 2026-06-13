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
]

function parseCustom(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Combined, de-duplicated term list (built-in + user custom). */
export function glossaryTerms(customRaw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of [...parseCustom(customRaw), ...BUILTIN_TERMS]) {
    const key = t.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(t)
    }
  }
  return out
}

/**
 * A compact comma-joined list for the translation prompt. Capped so it never
 * dominates the prompt; user terms come first (highest priority).
 */
export function glossaryForPrompt(customRaw: string, max = 60): string {
  return glossaryTerms(customRaw).slice(0, max).join(', ')
}

/**
 * Deepgram keyterms are capped at ~500 tokens total; trim to a safe count and
 * keep user terms first.
 */
export function glossaryForDeepgram(customRaw: string, max = 80): string[] {
  return glossaryTerms(customRaw).slice(0, max)
}
