import { isMasterPlaylistUrl, streamInfoFromUrl } from "../core/mediaid";

/**
 * Passive stream-URL capture. The X player fetches playlists/segments from
 * video.twimg.com inside the user's own session; we only observe request URLs
 * via webRequest (never bodies) and remember, per media id, where the master
 * playlist / mp4 variants live. The content script later correlates a player
 * with its media id (via the poster URL) and asks us for the stream.
 */

export interface CapturedMedia {
	masterUrl?: string;
	mp4: { url: string; pixels: number }[];
	at: number;
}

const SESSION_KEY = "capture:v1";
const MAX_MEDIA = 300;

const media = new Map<string, CapturedMedia>();
let restored = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

export function initCapture(): void {
	// Listener must be registered synchronously at SW startup.
	chrome.webRequest.onBeforeRequest.addListener(
		(details) => {
			const info = streamInfoFromUrl(details.url);
			if (!info) return;
			const entry = media.get(info.id) ?? { mp4: [], at: 0 };
			entry.at = Date.now();
			if (info.type === "m3u8") {
				// Only pin the true master so rendition selection is deterministic;
				// ignore variant playlists the player also fetches.
				if (isMasterPlaylistUrl(info.url)) entry.masterUrl = info.url;
			} else if (!entry.mp4.some((m) => m.url === info.url)) {
				entry.mp4.push({
					url: info.url,
					pixels: info.pixels ?? Number.MAX_SAFE_INTEGER,
				});
			}
			media.set(info.id, entry);
			trim();
			schedulePersist();
		},
		{ urls: ["*://video.twimg.com/*"] },
	);
	void restore();
}

export async function lookupMedia(
	mediaId: string,
): Promise<CapturedMedia | null> {
	await restore();
	return media.get(mediaId) ?? null;
}

function trim(): void {
	if (media.size <= MAX_MEDIA) return;
	const sorted = [...media.entries()].sort((a, b) => a[1].at - b[1].at);
	for (const [id] of sorted.slice(0, media.size - MAX_MEDIA)) media.delete(id);
}

/** Survive MV3 service-worker restarts within the browser session. */
function schedulePersist(): void {
	if (persistTimer) return;
	persistTimer = setTimeout(() => {
		persistTimer = undefined;
		void chrome.storage.session.set({
			[SESSION_KEY]: Object.fromEntries(media),
		});
	}, 1000);
}

async function restore(): Promise<void> {
	if (restored) return;
	restored = true;
	try {
		const raw = await chrome.storage.session.get(SESSION_KEY);
		const saved = raw[SESSION_KEY] as Record<string, CapturedMedia> | undefined;
		if (saved) {
			for (const [id, entry] of Object.entries(saved)) {
				if (!media.has(id)) media.set(id, entry);
			}
		}
	} catch {
		// storage.session unavailable — capture still works in-memory
	}
}
