# Acousmos Captions — project instructions

Bilingual AI captions for X (Twitter) videos. MV3 browser extension,
TypeScript (strict), esbuild, vitest. **Zero runtime dependencies** — every
provider integration is plain `fetch`. Part of the Acousmos product family
([[decisions/2026-06-12-acousmos-captions-product-and-repo-setup]] in whalemind).

## Commands

- `pnpm dev` — watch build to `dist/`
- `pnpm build` — production build to `dist/`
- `pnpm test` — unit tests (vitest)
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm check` — typecheck + test + build (run before committing)
- `pnpm zip` — build + package `release/acousmos-captions-<version>.zip`

After a build, the unpacked extension in `chrome://extensions` must be
**reloaded** to pick up changes (the dist is replaced on each build).

## Architecture

```
src/
  shared/    types, settings schema, messaging protocol, i18n, glossary
  core/      pure logic (unit-tested): HLS parsing, media-id correlation,
             cue building, SRT, ASR providers, translation providers, cache
  bg/        MV3 service worker: stream capture, windowed audio assembly,
             job pipeline (chunked ASR -> cues -> translate), keepalive
  content/   player discovery, CC pill + menu, bilingual overlay, SRT export
  options/   settings page (keys, languages, glossary, display)
  popup/     status + master toggle
```

## Invariants — do not break

- **Timeline integrity.** ASR word/utterance timestamps are the only source of
  cue boundaries. Translation receives `(id, text)` pairs only and never sees
  or alters timing. Cues merge/split before translation (`core/cues.ts`); the
  LLM only fills `tgt` keyed by cue id.
- **BYOK privacy.** API keys live in `chrome.storage.local` only — never
  `storage.sync`, never sent anywhere except the provider the user chose. No
  telemetry. No Acousmos server in the data path. Keep PRIVACY.md true.
- **i18n parity.** Every user-facing string goes through `t()` / `data-i18n`
  and must exist in both `_locales/en` and `_locales/zh_CN`.
- **Verify before committing.** `pnpm check` must pass. Add/adjust tests when
  changing `core/` logic.

## Provider defaults (verify before changing — APIs move)

- ASR: Soniox `stt-async-v5` (default) and Deepgram `nova-3`. Glossary terms go
  to Soniox `context.terms` and Deepgram `keyterm`.
- Translation: OpenAI-compatible (default model `gpt-4.1-mini`) and Anthropic
  (default `claude-haiku-4-5`). Prefer `gpt-4.1-mini` over `gpt-4o-mini` — it
  follows the strict JSON / id-anchoring instructions more reliably at similar
  cost; `4o-mini` drops or renumbers ids more often.

## Commit convention

Use **Conventional Commits** with a descriptive body. The body matters — it is
the reference when revisiting a change later.

- Subject: `type(scope): imperative summary` (≤ ~72 chars).
  - types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `build`.
  - scopes used here: `asr`, `translate`, `cues`, `pipeline`, `content`,
    `display`, `options`, `popup`, `ui`, `core`, `bg`.
- Body: explain **what changed and why**, and the user-visible effect. Wrap at
  ~72 cols. Reference the symptom being fixed when it's a bug.
- One coherent change per commit; split unrelated work.

Examples:

```
fix(cues): group words into sentence-sized cues before translation

The old builder only merged utterances <=0.5s apart, so a sentence split
across ASR utterances ("...Google" + "Cloud?") was translated in halves
and came out garbled. buildCues now regroups words on sentence
boundaries, so the LLM sees complete thoughts.
```

```
feat(display): caption mode, placement, and tighter default sizing
```

End commit messages with the Co-Authored-By trailer when authored with Claude.
