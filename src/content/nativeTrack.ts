import type { Utterance } from "../shared/types";

const MIN_NATIVE_CUES = 5;

/**
 * If the video carries its own subtitle/caption track (creator-provided or
 * platform-generated), reuse it instead of running ASR: it's accurate, free,
 * and already time-aligned. We also switch every text track to 'hidden' so the
 * browser stops drawing native captions on top of our bilingual overlay.
 *
 * Returns the track's cues as utterances, or null to fall back to ASR.
 */
export async function getNativeUtterances(
	video: HTMLVideoElement,
	sourceLang: string,
	timeoutMs = 2500,
): Promise<Utterance[] | null> {
	const tracks = [...video.textTracks].filter(
		(t) => t.kind === "subtitles" || t.kind === "captions",
	);
	if (tracks.length === 0) return null;
	// 'hidden' populates cues without the browser rendering them over our overlay.
	for (const t of tracks) t.mode = "hidden";

	const best = await waitForCues(tracks, sourceLang, timeoutMs);
	const list = best?.cues;
	if (!list || list.length < MIN_NATIVE_CUES) return null;

	const utts: Utterance[] = [];
	for (let i = 0; i < list.length; i++) {
		const cue = list[i] as VTTCue;
		const text = cleanCueText(cue.text ?? "");
		if (text) utts.push({ text, start: cue.startTime, end: cue.endTime });
	}
	return utts.length >= MIN_NATIVE_CUES ? utts : null;
}

async function waitForCues(
	tracks: TextTrack[],
	sourceLang: string,
	timeoutMs: number,
): Promise<TextTrack | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const withCues = tracks.filter((t) => (t.cues?.length ?? 0) > 0);
		if (withCues.length > 0) {
			if (sourceLang !== "auto") {
				const match = withCues.find(
					(t) =>
						t.language &&
						t.language.toLowerCase().startsWith(sourceLang.toLowerCase()),
				);
				if (match) return match;
			}
			// Otherwise the main track is the one with the most cues.
			return (
				withCues.sort(
					(a, b) => (b.cues?.length ?? 0) - (a.cues?.length ?? 0),
				)[0] ?? null
			);
		}
		if (Date.now() > deadline) return null;
		await new Promise((r) => setTimeout(r, 150));
	}
}

/** VTT cue text may carry markup and line breaks — flatten to plain text. */
function cleanCueText(raw: string): string {
	return raw
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
}
