import type { BatchItem, TranslateContext } from "./types";

export function systemPrompt(targetLang: string, glossary = ""): string {
	const lines = [
		`You are a professional subtitle translator. Translate each subtitle segment into ${targetLang}.`,
		'Each input segment is {"i":<id>,"s":"<source text>"}.',
		"Rules:",
		"- Translate naturally and idiomatically; subtitles are read while watching, so keep lines tight.",
		"- Keep proper nouns, product names, and technical terms recognizable (translate or keep English, whichever a native reader expects).",
		"- Segments are fragments of continuous speech; use the provided context for pronouns and continuity.",
		"- A sentence may be split across several segments. Translate each segment as the portion that aligns with it (translate that span only); do NOT fold the whole sentence into the first segment and leave the others empty or shifted.",
		"- ASR may mishear technical names; correct obvious mistakes using the glossary below before translating.",
		'- Output JSON only: {"items":[{"i":<id>,"s":"<source>","t":"<translation>"}, ...]}.',
		'- For every segment, copy its "s" back UNCHANGED (character for character) and put your translation in "t". The echoed "s" is used to confirm each translation is on the correct line.',
		"- Return exactly one item per input id, in the same order, with the same id values. Never merge, split, reorder, omit, or invent ids; the output array length must equal the input length.",
		"- No explanations, no markdown fences.",
	];
	if (glossary) {
		lines.push(
			`Glossary — apply consistently, and fix obvious ASR mishearings of these names: ${glossary}. ` +
				'("always render: X→Y" = translate X as Y every time; "keep in English" = leave those terms untranslated.)',
		);
	}
	return lines.join("\n");
}

export function userPrompt(items: BatchItem[], ctx: TranslateContext): string {
	const payload: Record<string, unknown> = {
		segments: items.map((it) => ({ i: it.i, s: it.t })),
	};
	if (ctx.prevSource.length > 0)
		payload["previous_lines_context"] = ctx.prevSource;
	return JSON.stringify(payload);
}

/** JSON Schema for Anthropic structured outputs (and documentation of shape). */
export const ITEMS_SCHEMA = {
	type: "object",
	properties: {
		items: {
			type: "array",
			items: {
				type: "object",
				properties: {
					i: { type: "integer" },
					s: { type: "string" },
					t: { type: "string" },
				},
				required: ["i", "s", "t"],
				additionalProperties: false,
			},
		},
	},
	required: ["items"],
	additionalProperties: false,
} as const;

/**
 * Tolerant extraction of {items:[{i,t}]} (or a bare array) from LLM text.
 * Returns only well-formed entries; the caller decides how to handle gaps.
 */
export function extractItems(text: string): BatchItem[] {
	const cleaned = text.replace(/```(?:json)?/gi, "").trim();
	const start = findJsonStart(cleaned);
	if (start === -1) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned.slice(start));
	} catch {
		// Try to salvage by trimming trailing junk after the last } or ].
		const lastBrace = Math.max(
			cleaned.lastIndexOf("}"),
			cleaned.lastIndexOf("]"),
		);
		if (lastBrace <= start) return [];
		try {
			parsed = JSON.parse(cleaned.slice(start, lastBrace + 1));
		} catch {
			return [];
		}
	}
	const arr = Array.isArray(parsed)
		? parsed
		: typeof parsed === "object" &&
				parsed !== null &&
				Array.isArray((parsed as { items?: unknown }).items)
			? (parsed as { items: unknown[] }).items
			: [];
	const out: BatchItem[] = [];
	for (const raw of arr) {
		if (typeof raw !== "object" || raw === null) continue;
		const entry = raw as { i?: unknown; t?: unknown; s?: unknown };
		if (!Number.isInteger(entry.i) || typeof entry.t !== "string") continue;
		const item: BatchItem = { i: entry.i as number, t: entry.t.trim() };
		if (typeof entry.s === "string") item.src = entry.s;
		out.push(item);
	}
	return out;
}

function findJsonStart(s: string): number {
	const obj = s.indexOf("{");
	const arr = s.indexOf("[");
	if (obj === -1) return arr;
	if (arr === -1) return obj;
	return Math.min(obj, arr);
}
