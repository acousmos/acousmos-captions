import { describe, expect, it } from "vitest";
import { tokensToUtterances, type SonioxToken } from "../src/core/asr/soniox";

function tok(text: string, startMs: number, endMs: number): SonioxToken {
	return { text, start_ms: startMs, end_ms: endMs };
}

describe("tokensToUtterances", () => {
	it("reassembles sub-word tokens into words (leading space = new word)", () => {
		const utts = tokensToUtterances([
			tok("Hel", 0, 120),
			tok("lo", 120, 200),
			tok(" wor", 250, 400),
			tok("ld.", 400, 520),
		]);
		expect(utts).toHaveLength(1);
		expect(utts[0]?.text).toBe("Hello world.");
		expect(utts[0]?.words).toEqual([
			{ text: "Hello", start: 0, end: 0.2 },
			{ text: "world.", start: 0.25, end: 0.52 },
		]);
	});

	it("splits on long silence gaps", () => {
		const utts = tokensToUtterances([
			tok("One", 0, 300),
			tok(" two", 350, 600),
			tok(" three", 2000, 2300), // 1.4s gap
		]);
		expect(utts.map((u) => u.text)).toEqual(["One two", "three"]);
		expect(utts[1]?.start).toBe(2);
	});

	it("splits after sentence-final punctuation with a small gap", () => {
		const utts = tokensToUtterances([
			tok("Done.", 0, 400),
			tok(" Next", 900, 1200), // 0.5s gap after a period
		]);
		expect(utts.map((u) => u.text)).toEqual(["Done.", "Next"]);
	});

	it("keeps continuous speech together across small gaps", () => {
		const utts = tokensToUtterances([
			tok("keep", 0, 200),
			tok(" going", 300, 500),
			tok(" here", 600, 800),
		]);
		expect(utts).toHaveLength(1);
	});

	it("ignores empty/whitespace tokens and handles empty input", () => {
		expect(tokensToUtterances([])).toEqual([]);
		expect(tokensToUtterances([tok("  ", 0, 10)])).toEqual([]);
	});

	it("timestamps are seconds derived from ms", () => {
		const utts = tokensToUtterances([tok("Hi", 1500, 1800)]);
		expect(utts[0]).toMatchObject({ start: 1.5, end: 1.8 });
	});
});
