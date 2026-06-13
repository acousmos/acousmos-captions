# Acousmos Captions

**Bilingual AI captions for X (Twitter) videos — the original line always stays visible.**

给 X(Twitter)视频一键加中英双语字幕:原文是锚点,译文是辅助。自带 Key(BYOK)、开源、无订阅。

[Acousmos](https://acousmos.com) 出品 · MIT License

---

## Why

Most videos on X have no captions. Existing translation extensions lock AI caption generation behind subscriptions, and their BYOK only covers the translation layer — never speech recognition. Open-source alternatives require local installs or self-hosted Docker.

Acousmos Captions takes a different position:

- **Bilingual, not translated.** You probably understand *some* of the original language — you just can't keep up by ear. The original line stays on screen as ground truth; the translation underneath is the assist. When a translation is imperfect, the original saves you. Translation-only captions can't do that.
- **BYOK all the way down.** Both the ASR key (Deepgram / Soniox) *and* the LLM key (OpenAI-compatible / Gemini / Anthropic) are yours, stored only in your browser, sent only to the provider you choose.
- **No subscription.** X videos are short; transcribing one costs fractions of a cent on your own key. There is nothing here worth ten dollars a month.

## How it works

```
X video page → stream captured in YOUR browser session (no server-side downloading)
            → audio-only HLS rendition fetched and assembled
            → ASR with timestamps (Deepgram nova-3 / Soniox async)
            → display cues built (merge-only; every boundary is an ASR timestamp)
            → LLM translates text anchored by cue id (timestamps never leave your machine)
            → bilingual overlay on the native player + SRT export
```

Key design constraints:

- **Timeline integrity.** The LLM receives `(id, text)` pairs only. It cannot reorder, merge, or re-time anything — translations are patched back by id onto immutable ASR anchors.
- **English first, translation streams in.** Original captions appear the moment transcription finishes; translated lines fill in batch by batch.
- **Your session, your videos.** Audio is fetched inside your logged-in browser session, the same way the player itself fetches it. Nothing is proxied through any server.
- **Cached.** Results are cached locally (LRU) — re-watching is free.

## Install

Until the Chrome Web Store listing is live:

1. Download the latest release zip (or `pnpm build` from source) — you need the `dist/` folder.
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select the `dist/` folder.
4. Open the extension's **Settings**, add an ASR key and an LLM key.
5. Open any X video, press the **CC** pill on the player.

### Keys

| Layer | Provider | Where to get a key |
|---|---|---|
| ASR | Deepgram (default, `nova-3`) | console.deepgram.com — generous free credit |
| ASR | Soniox (`stt-async`) | console.soniox.com |
| LLM | Any OpenAI-compatible endpoint (OpenAI, DeepSeek, Groq, local…) | configurable base URL + model |
| LLM | Google Gemini (`gemini-3.5-flash` default) | aistudio.google.com/apikey |
| LLM | Anthropic (`claude-haiku-4-5` default) | console.anthropic.com |

Keys live in `chrome.storage.local` only — never synced, never sent to Acousmos.

## Develop

```sh
pnpm install
pnpm dev        # watch build → dist/
pnpm check      # typecheck + unit tests + build
pnpm zip        # release/acousmos-captions-<version>.zip
```

Stack: TypeScript (strict), esbuild, vitest. Zero runtime dependencies — every provider integration is plain `fetch`.

```
src/
  shared/    types, settings schema, messaging protocol, i18n
  core/      pure logic: HLS parsing, media-id correlation, cue building,
             SRT, ASR providers, translation providers, cache  ← unit-tested
  bg/        MV3 service worker: stream capture, audio assembly, job pipeline
  content/   player discovery, CC pill, bilingual overlay, SRT export
  options/   settings page (keys, languages, display)
  popup/     status + quick toggle
```

## Roadmap

- [ ] Hosted fallback quota via an Acousmos account, for users who don't want to manage keys (the extension stays fully functional BYOK-only)
- [ ] Firefox port
- [ ] More platforms beyond X

## Privacy

See [PRIVACY.md](PRIVACY.md). Short version: no telemetry, no Acousmos servers in the data path, audio goes only to the ASR provider you configured, text only to the LLM you configured.

## License

[MIT](LICENSE) © Acousmos
