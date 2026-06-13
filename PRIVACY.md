# Privacy

Acousmos Captions is designed so that **no Acousmos server ever touches your data**.

## What the extension processes

- **Video audio.** When you press CC on an X video, the audio stream is fetched inside your own browser session (the same requests the X player makes) and sent **directly** to the ASR provider you configured (Deepgram or Soniox) to be transcribed. It is not sent anywhere else.
- **Transcribed text.** Subtitle text (never timestamps, never video URLs) is sent **directly** to the translation provider you configured (an OpenAI-compatible endpoint, Google Gemini, or Anthropic).
- **API keys.** Stored in `chrome.storage.local` on your machine only. They are never synced via your browser account and never transmitted to Acousmos.
- **Results cache.** Generated captions are cached locally so re-watching a video is free. You can clear the cache in Settings.

## What the extension does NOT do

- No analytics, no telemetry, no crash reporting.
- No account required; nothing is uploaded to acousmos.com.
- No browsing history collection — the extension only reacts to video players on x.com / twitter.com, and only when you press the CC button.
- No remote code; everything ships in the reviewed extension package.

## Third parties

Your audio/text is subject to the privacy policy of the providers **you** choose and key:

- Deepgram: deepgram.com/privacy
- Soniox: soniox.com/privacy
- OpenAI (or your chosen compatible endpoint's policy): openai.com/policies
- Google Gemini: ai.google.dev/gemini-api/terms
- Anthropic: anthropic.com/legal/privacy

If a future opt-in hosted mode is added (Acousmos-managed quota), it will be clearly labeled, off by default, and documented here before release.
