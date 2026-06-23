import { describe, expect, it } from "vitest";
import {
	buildCues,
	DEFAULT_CUE_OPTIONS,
	findCueIndex,
	lastCueIndexBefore,
} from "../src/core/cues";
import type { Utterance, Word } from "../src/shared/types";

function words(spec: [string, number, number][]): Word[] {
	return spec.map(([text, start, end]) => ({ text, start, end }));
}

describe("buildCues — sentence-aware grouping", () => {
	it('merges a sentence split across ASR utterances (the "Google Cloud?" case)', () => {
		// ASR split the question: one utterance ends "...Google", the next is "Cloud?".
		const utts: Utterance[] = [
			{
				start: 39,
				end: 44.1,
				text: "how many of you used the same AI tool to deploy on Google",
				words: words([
					["how", 39, 39.2],
					["many", 39.2, 39.4],
					["of", 39.4, 39.5],
					["you", 39.5, 39.7],
					["used", 39.7, 40],
					["the", 40, 40.1],
					["same", 40.1, 40.4],
					["AI", 40.4, 40.7],
					["tool", 40.7, 41],
					["to", 41, 41.1],
					["deploy", 41.1, 41.6],
					["on", 41.6, 41.8],
					["Google", 41.8, 44.1],
				]),
			},
			{
				start: 44.3,
				end: 45.1,
				text: "Cloud?",
				words: words([["Cloud?", 44.3, 45.1]]),
			},
		];
		const cues = buildCues(utts);
		expect(cues).toHaveLength(1);
		expect(cues[0]!.src).toBe(
			"how many of you used the same AI tool to deploy on Google Cloud?",
		);
		expect(cues[0]!.start).toBe(39);
		expect(cues[0]!.end).toBe(45.1);
	});

	it("breaks at sentence boundaries", () => {
		const utts: Utterance[] = [
			{
				start: 0,
				end: 4,
				text: "This is one sentence. And here is another one.",
				words: words([
					["This", 0, 0.3],
					["is", 0.3, 0.5],
					["one", 0.5, 0.8],
					["sentence.", 0.8, 1.3],
					["And", 1.8, 2],
					["here", 2, 2.3],
					["is", 2.3, 2.5],
					["another", 2.5, 3],
					["one.", 3, 3.4],
				]),
			},
		];
		const cues = buildCues(utts);
		expect(cues.map((c) => c.src)).toEqual([
			"This is one sentence.",
			"And here is another one.",
		]);
	});

	it("merges short interjections instead of making micro-cues", () => {
		const utts: Utterance[] = [
			{
				start: 0,
				end: 3,
				text: "Um. So what we built here is a dashboard.",
				words: words([
					["Um.", 0, 0.3],
					["So", 0.4, 0.6],
					["what", 0.6, 0.8],
					["we", 0.8, 0.9],
					["built", 0.9, 1.2],
					["here", 1.2, 1.5],
					["is", 1.5, 1.6],
					["a", 1.6, 1.7],
					["dashboard.", 1.7, 2.4],
				]),
			},
		];
		const cues = buildCues(utts);
		expect(cues).toHaveLength(1);
		expect(cues[0]!.src).toBe("Um. So what we built here is a dashboard.");
	});

	it("splits a run-on at the maxChars cap (boundary is a word timestamp)", () => {
		const spec: [string, number, number][] = Array.from(
			{ length: 40 },
			(_, i) => [`word${i}`, i * 0.3, i * 0.3 + 0.25],
		);
		const cues = buildCues([
			{
				start: 0,
				end: 12,
				text: spec.map((s) => s[0]).join(" "),
				words: words(spec),
			},
		]);
		expect(cues.length).toBeGreaterThan(1);
		const starts = spec.map((s) => s[1]);
		const ends = spec.map((s) => s[2]);
		for (const c of cues) {
			expect(c.src.length).toBeLessThanOrEqual(DEFAULT_CUE_OPTIONS.maxChars);
			expect(starts).toContain(c.start);
			expect(ends).toContain(c.end);
		}
		// No reordering, full coverage.
		expect(cues.map((c) => c.src).join(" ")).toBe(
			spec.map((s) => s[0]).join(" "),
		);
	});

	it("keeps a sentence with internal commas whole", () => {
		const cues = buildCues([
			{
				start: 0,
				end: 2,
				text: "Hi there, friend.",
				words: words([
					["Hi", 0, 0.3],
					["there,", 0.3, 0.6],
					["friend.", 0.6, 1],
				]),
			},
		]);
		expect(cues).toHaveLength(1);
		expect(cues[0]!.src).toBe("Hi there, friend.");
	});

	it("breaks on a long pause even without punctuation", () => {
		const utts: Utterance[] = [
			{
				start: 0,
				end: 1,
				text: "first part",
				words: words([
					["first", 0, 0.5],
					["part", 0.5, 1],
				]),
			},
			{
				start: 4,
				end: 5,
				text: "second part",
				words: words([
					["second", 4, 4.5],
					["part", 4.5, 5],
				]),
			},
		];
		const cues = buildCues(utts);
		expect(cues.map((c) => c.src)).toEqual(["first part", "second part"]);
	});

	it("falls back to utterance text when no word timestamps are present", () => {
		const cues = buildCues([
			{ start: 0, end: 2, text: "Hello there." },
			{ start: 5, end: 7, text: "Goodbye now." },
		]);
		expect(cues.map((c) => c.src)).toEqual(["Hello there.", "Goodbye now."]);
	});

	it("joins CJK without inserting spaces", () => {
		const cues = buildCues([
			{
				start: 0,
				end: 2,
				text: "你好",
				words: words([
					["你好", 0, 1],
					["世界", 1, 2],
				]),
			},
		]);
		expect(cues[0]?.src).toBe("你好世界");
	});

	it("assigns sequential ids", () => {
		const cues = buildCues([
			{ start: 0, end: 1, text: "One.", words: words([["One.", 0, 1]]) },
			{ start: 2, end: 3, text: "Two.", words: words([["Two.", 2, 3]]) },
		]);
		expect(cues.map((c) => c.id)).toEqual([0, 1]);
	});
});

describe("findCueIndex", () => {
	const cues = buildCues([
		{ start: 0, end: 2, text: "a." },
		{ start: 3, end: 5, text: "b." },
		{ start: 6, end: 8, text: "c." },
	]);
	it("finds covering cue", () => {
		expect(findCueIndex(cues, 1)).toBe(0);
		expect(findCueIndex(cues, 4)).toBe(1);
		expect(findCueIndex(cues, 7.9)).toBe(2);
	});
	it("returns -1 in gaps and outside range", () => {
		expect(findCueIndex(cues, 2.5)).toBe(-1);
		expect(findCueIndex(cues, 100)).toBe(-1);
	});
});

describe("lastCueIndexBefore", () => {
	const cues = buildCues([
		{ start: 0, end: 2, text: "a." },
		{ start: 3, end: 5, text: "b." },
		{ start: 6, end: 8, text: "c." },
	]);
	it("returns the covering cue when inside one", () => {
		expect(lastCueIndexBefore(cues, 4)).toBe(1);
	});
	it("returns the most recent preceding cue in a gap (linger when paused)", () => {
		expect(lastCueIndexBefore(cues, 2.5)).toBe(0);
		expect(lastCueIndexBefore(cues, 5.5)).toBe(1);
		expect(lastCueIndexBefore(cues, 100)).toBe(2);
	});
	it("returns -1 before the first cue", () => {
		expect(lastCueIndexBefore(cues, -1)).toBe(-1);
	});
});
