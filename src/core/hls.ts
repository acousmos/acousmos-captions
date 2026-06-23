/**
 * Minimal HLS (m3u8) parsing — only what is needed to pull the smallest
 * audio-bearing rendition out of X's video playlists.
 */

export interface AudioRendition {
	uri: string;
	groupId: string;
	name?: string;
	isDefault: boolean;
}

export interface Variant {
	uri: string;
	bandwidth: number;
	audioGroup?: string;
	resolution?: string;
}

export interface MasterPlaylist {
	audio: AudioRendition[];
	variants: Variant[];
}

export interface MediaPlaylist {
	initUri?: string;
	segmentUris: string[];
	/** Per-segment duration in seconds, parallel to segmentUris. */
	segmentDurations: number[];
	totalDuration: number;
}

/** Parse an EXT-X attribute list, honoring quoted values containing commas. */
export function parseAttributes(s: string): Record<string, string> {
	const out: Record<string, string> = {};
	const re = /([A-Z0-9-]+)=("(?:[^"]*)"|[^,]*)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s))) {
		const key = m[1];
		let value = m[2] ?? "";
		if (value.startsWith('"') && value.endsWith('"'))
			value = value.slice(1, -1);
		if (key) out[key] = value;
	}
	return out;
}

export function isMasterPlaylist(text: string): boolean {
	return text.includes("#EXT-X-STREAM-INF");
}

export function resolveUrl(base: string, ref: string): string {
	return new URL(ref, base).toString();
}

export function parseMaster(text: string, baseUrl: string): MasterPlaylist {
	const audio: AudioRendition[] = [];
	const variants: Variant[] = [];
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim();
		if (line.startsWith("#EXT-X-MEDIA:")) {
			const attrs = parseAttributes(line.slice("#EXT-X-MEDIA:".length));
			if (attrs["TYPE"] === "AUDIO" && attrs["URI"] && attrs["GROUP-ID"]) {
				audio.push({
					uri: resolveUrl(baseUrl, attrs["URI"]),
					groupId: attrs["GROUP-ID"],
					name: attrs["NAME"],
					isDefault: attrs["DEFAULT"] === "YES",
				});
			}
		} else if (line.startsWith("#EXT-X-STREAM-INF:")) {
			const attrs = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
			// The variant URI is the next non-comment, non-empty line.
			let j = i + 1;
			while (
				j < lines.length &&
				((lines[j] ?? "").trim() === "" ||
					(lines[j] ?? "").trim().startsWith("#"))
			)
				j++;
			const uriLine = (lines[j] ?? "").trim();
			if (uriLine) {
				variants.push({
					uri: resolveUrl(baseUrl, uriLine),
					bandwidth: Number(attrs["BANDWIDTH"] ?? 0),
					audioGroup: attrs["AUDIO"],
					resolution: attrs["RESOLUTION"],
				});
				i = j;
			}
		}
	}
	return { audio, variants };
}

export function parseMedia(text: string, baseUrl: string): MediaPlaylist {
	let initUri: string | undefined;
	const segmentUris: string[] = [];
	const segmentDurations: number[] = [];
	let totalDuration = 0;
	let pendingDur = 0;
	let expectSegment = false;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		if (line.startsWith("#EXT-X-MAP:")) {
			const attrs = parseAttributes(line.slice("#EXT-X-MAP:".length));
			if (attrs["URI"]) initUri = resolveUrl(baseUrl, attrs["URI"]);
		} else if (line.startsWith("#EXTINF:")) {
			const dur = parseFloat(line.slice("#EXTINF:".length));
			pendingDur = Number.isFinite(dur) ? dur : 0;
			expectSegment = true;
		} else if (!line.startsWith("#") && expectSegment) {
			segmentUris.push(resolveUrl(baseUrl, line));
			segmentDurations.push(pendingDur);
			totalDuration += pendingDur;
			pendingDur = 0;
			expectSegment = false;
		}
	}
	return { initUri, segmentUris, segmentDurations, totalDuration };
}

export interface SegmentWindow {
	/** Inclusive start index into segmentUris. */
	startIndex: number;
	/** Exclusive end index into segmentUris. */
	endIndex: number;
	/** Absolute time offset (seconds) of this window's first segment. */
	startTime: number;
}

/**
 * Group segments into ~`windowSec` windows so the pipeline can transcribe and
 * show captions for the start of a long video without waiting for the whole
 * thing. Each window holds at least one segment; the last is whatever remains.
 */
export function planWindows(
	durations: number[],
	windowSec: number,
): SegmentWindow[] {
	const windows: SegmentWindow[] = [];
	let startIndex = 0;
	let startTime = 0;
	let acc = 0;
	let elapsed = 0;
	for (let i = 0; i < durations.length; i++) {
		acc += durations[i] ?? 0;
		elapsed += durations[i] ?? 0;
		if (acc >= windowSec) {
			windows.push({ startIndex, endIndex: i + 1, startTime });
			startIndex = i + 1;
			startTime = elapsed;
			acc = 0;
		}
	}
	if (startIndex < durations.length) {
		windows.push({ startIndex, endIndex: durations.length, startTime });
	}
	return windows;
}

export interface AudioSourcePick {
	uri: string;
	/** 'audio' = audio-only rendition; 'muxed' = full variant (audio+video). */
	kind: "audio" | "muxed";
}

/**
 * Prefer a dedicated audio rendition (smallest payload, exactly what ASR
 * needs); otherwise fall back to the lowest-bandwidth muxed variant.
 */
export function pickAudioSource(
	master: MasterPlaylist,
): AudioSourcePick | null {
	if (master.audio.length > 0) {
		const def = master.audio.find((a) => a.isDefault) ?? master.audio[0];
		if (def) return { uri: def.uri, kind: "audio" };
	}
	if (master.variants.length > 0) {
		const lowest = [...master.variants].sort(
			(a, b) => a.bandwidth - b.bandwidth,
		)[0];
		if (lowest) return { uri: lowest.uri, kind: "muxed" };
	}
	return null;
}

/** Best-effort MIME for the assembled segment stream. */
export function mimeForPlaylist(
	media: MediaPlaylist,
	kind: "audio" | "muxed",
): string {
	const sample = media.initUri ?? media.segmentUris[0] ?? "";
	const path = sample.split("?")[0] ?? "";
	if (path.endsWith(".ts")) return "video/mp2t";
	if (path.endsWith(".aac")) return "audio/aac";
	return kind === "audio" ? "audio/mp4" : "video/mp4";
}
