import {
	JobError,
	type AudioPayload,
	type Utterance,
	type Word,
} from "../../shared/types";
import { fetchRetry, readErrorBody } from "../../shared/net";
import type { AsrOptions, AsrProvider } from "./types";

const API = "https://api.soniox.com/v1";
const MODEL = "stt-async-v5";
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 15 * 60_000;

export interface SonioxToken {
	text: string;
	start_ms: number;
	end_ms: number;
}

export const soniox: AsrProvider = {
	id: "soniox",

	async transcribe(
		audio: AudioPayload,
		opts: AsrOptions,
	): Promise<Utterance[]> {
		const auth = { Authorization: `Bearer ${opts.key}` };

		// 1) Upload audio file.
		const form = new FormData();
		const ext = audio.mime.includes("mp2t")
			? "ts"
			: audio.mime.includes("aac")
				? "aac"
				: "mp4";
		form.append(
			"file",
			new Blob([audio.bytes as unknown as BlobPart], { type: audio.mime }),
			`audio.${ext}`,
		);
		const upload = await fetchRetry(
			`${API}/files`,
			{ method: "POST", headers: auth, body: form },
			{ signal: opts.signal, timeoutMs: 180_000 },
		);
		if (upload.status === 401 || upload.status === 403) {
			throw new JobError("err_asr_auth", await readErrorBody(upload));
		}
		if (!upload.ok)
			throw new JobError(
				"err_asr_failed",
				`Soniox upload HTTP ${upload.status}: ${await readErrorBody(upload)}`,
			);
		const fileId = ((await upload.json()) as { id: string }).id;

		let transcriptionId: string | undefined;
		try {
			// 2) Create transcription job.
			const body: Record<string, unknown> = { model: MODEL, file_id: fileId };
			if (opts.sourceLang !== "auto")
				body["language_hints"] = [opts.sourceLang];
			// V5 structured context biases recognition toward glossary terms.
			if (opts.terms && opts.terms.length > 0)
				body["context"] = { terms: opts.terms };
			const create = await fetchRetry(
				`${API}/transcriptions`,
				{
					method: "POST",
					headers: { ...auth, "Content-Type": "application/json" },
					body: JSON.stringify(body),
				},
				{ signal: opts.signal },
			);
			if (!create.ok)
				throw new JobError(
					"err_asr_failed",
					`Soniox create HTTP ${create.status}: ${await readErrorBody(create)}`,
				);
			transcriptionId = ((await create.json()) as { id: string }).id;

			// 3) Poll until completed.
			const deadline = Date.now() + POLL_TIMEOUT_MS;
			for (;;) {
				if (opts.signal?.aborted)
					throw new JobError("err_asr_failed", "aborted");
				if (Date.now() > deadline)
					throw new JobError("err_asr_failed", "Soniox polling timed out");
				const st = await fetchRetry(
					`${API}/transcriptions/${transcriptionId}`,
					{ headers: auth },
					{ signal: opts.signal },
				);
				if (!st.ok)
					throw new JobError(
						"err_asr_failed",
						`Soniox status HTTP ${st.status}`,
					);
				const status = (await st.json()) as {
					status: string;
					error_message?: string;
				};
				if (status.status === "completed") break;
				if (status.status === "error")
					throw new JobError(
						"err_asr_failed",
						status.error_message ?? "Soniox transcription error",
					);
				await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
			}

			// 4) Fetch transcript tokens.
			const tr = await fetchRetry(
				`${API}/transcriptions/${transcriptionId}/transcript`,
				{ headers: auth },
				{ signal: opts.signal },
			);
			if (!tr.ok)
				throw new JobError(
					"err_asr_failed",
					`Soniox transcript HTTP ${tr.status}`,
				);
			const transcript = (await tr.json()) as { tokens?: SonioxToken[] };
			return tokensToUtterances(transcript.tokens ?? []);
		} finally {
			// Best-effort cleanup; the user's account should not accumulate files.
			void cleanup(
				`${API}/transcriptions/${transcriptionId ?? ""}`,
				auth,
				Boolean(transcriptionId),
			);
			void cleanup(`${API}/files/${fileId}`, auth, true);
		}
	},

	async testKey(key: string): Promise<boolean> {
		const res = await fetch(`${API}/files?limit=1`, {
			headers: { Authorization: `Bearer ${key}` },
		});
		return res.ok;
	},
};

async function cleanup(
	url: string,
	auth: Record<string, string>,
	enabled: boolean,
): Promise<void> {
	if (!enabled) return;
	try {
		await fetch(url, { method: "DELETE", headers: auth });
	} catch {
		// ignore
	}
}

const SENTENCE_END = /[.!?。!?…]["')\]]?$/;
const MAX_UTT_SEC = 12;
const MAX_UTT_CHARS = 300;
const GAP_BREAK_SEC = 1.0;
const GAP_AFTER_SENTENCE_SEC = 0.3;

/**
 * Soniox async returns sub-word tokens (text fragments with ms timestamps;
 * a leading space marks a new word). Reassemble into words, then group into
 * utterances on silence gaps and sentence-final punctuation.
 */
export function tokensToUtterances(tokens: SonioxToken[]): Utterance[] {
	const words: Word[] = [];
	for (const tok of tokens) {
		const raw = tok.text;
		if (!raw || !raw.trim()) continue;
		const startsWord = /^\s/.test(raw) || words.length === 0;
		const text = raw.replace(/^\s+/, "");
		const start = tok.start_ms / 1000;
		const end = tok.end_ms / 1000;
		const last = words[words.length - 1];
		if (startsWord || !last) {
			words.push({ text, start, end });
		} else {
			last.text += text;
			last.end = end;
		}
	}

	const utterances: Utterance[] = [];
	let bucket: Word[] = [];
	const flush = () => {
		if (bucket.length === 0) return;
		const first = bucket[0]!;
		const last = bucket[bucket.length - 1]!;
		utterances.push({
			start: first.start,
			end: last.end,
			text: bucket.map((w) => w.text).join(" "),
			words: bucket,
		});
		bucket = [];
	};
	for (const w of words) {
		const prev = bucket[bucket.length - 1];
		if (prev) {
			const gap = w.start - prev.end;
			const chars = bucket.reduce((n, b) => n + b.text.length + 1, 0);
			const dur = prev.end - bucket[0]!.start;
			const sentenceDone = SENTENCE_END.test(prev.text);
			if (
				gap > GAP_BREAK_SEC ||
				(sentenceDone && gap > GAP_AFTER_SENTENCE_SEC) ||
				dur > MAX_UTT_SEC ||
				chars > MAX_UTT_CHARS
			) {
				flush();
			}
		}
		bucket.push(w);
	}
	flush();
	return utterances;
}
