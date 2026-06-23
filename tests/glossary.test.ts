import { describe, expect, it } from "vitest";
import {
	BUILTIN_TERMS,
	glossaryForDeepgram,
	glossaryForPrompt,
	glossaryTerms,
} from "../src/shared/glossary";

describe("glossaryTerms", () => {
	it("puts user custom terms first, then built-ins", () => {
		const terms = glossaryTerms("Acousmos, BloxFlux");
		expect(terms[0]).toBe("Acousmos");
		expect(terms[1]).toBe("BloxFlux");
		expect(terms).toContain("Claude Code");
	});

	it("parses comma and newline separated custom terms", () => {
		const terms = glossaryTerms("Foo\nBar, Baz");
		expect(terms.slice(0, 3)).toEqual(["Foo", "Bar", "Baz"]);
	});

	it("de-duplicates case-insensitively (custom wins position)", () => {
		const terms = glossaryTerms("anthropic");
		expect(terms[0]).toBe("anthropic");
		expect(terms.filter((t) => t.toLowerCase() === "anthropic")).toHaveLength(
			1,
		);
	});

	it("ignores blanks", () => {
		expect(glossaryTerms("  ,\n , ")).toEqual([...BUILTIN_TERMS]);
	});

	it("keeps only the source term from a word=译法 entry (ASR needs the spelling)", () => {
		const terms = glossaryTerms("Foobar=福报");
		expect(terms[0]).toBe("Foobar");
		expect(terms).not.toContain("Foobar=福报");
	});
});

describe("glossaryForDeepgram", () => {
	it("caps the term count", () => {
		expect(glossaryForDeepgram("", 5)).toHaveLength(5);
	});
});

describe("glossaryForPrompt", () => {
	it("lists keep-in-English terms", () => {
		const s = glossaryForPrompt("Acousmos", "zh-CN");
		expect(s).toContain("keep in English:");
		expect(s).toContain("Acousmos");
	});

	it("includes the high-value product names by default (not sliced off)", () => {
		const s = glossaryForPrompt("", "zh-CN");
		expect(s).toContain("Computer Use");
		expect(s).toContain("Core Web Vitals");
		expect(s).toContain("Chrome DevTools");
	});

	it("applies built-in forced translations for a Chinese target", () => {
		const s = glossaryForPrompt("", "zh-CN");
		expect(s).toContain("always render:");
		expect(s).toContain("agent→智能体");
	});

	it("uses Traditional Chinese mappings for zh-TW (not Simplified)", () => {
		const s = glossaryForPrompt("", "zh-TW");
		expect(s).toContain("agent→智能體");
		expect(s).not.toContain("智能体");
	});

	it("does NOT apply the Chinese built-in mappings for a non-Chinese target", () => {
		const s = glossaryForPrompt("", "ja");
		expect(s).not.toContain("智能体");
		expect(s).not.toContain("智能體");
	});

	it("lets a user entry override a built-in mapping", () => {
		const s = glossaryForPrompt("agent=代理", "zh-CN");
		expect(s).toContain("agent→代理");
		expect(s).not.toContain("agent→智能体");
	});
});
