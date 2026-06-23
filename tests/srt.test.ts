import { describe, expect, it } from "vitest";
import { formatSrtTime, srtFilename, toSrt } from "../src/core/srt";
import type { Cue } from "../src/shared/types";

describe("formatSrtTime", () => {
	it("formats with comma milliseconds", () => {
		expect(formatSrtTime(0)).toBe("00:00:00,000");
		expect(formatSrtTime(61.5)).toBe("00:01:01,500");
		expect(formatSrtTime(3661.042)).toBe("01:01:01,042");
	});
	it("clamps negatives to zero", () => {
		expect(formatSrtTime(-1)).toBe("00:00:00,000");
	});
});

const cues: Cue[] = [
	{ id: 0, start: 0, end: 2, src: "Hello world.", tgt: "你好,世界。" },
	{ id: 1, start: 3, end: 5, src: "No translation yet." },
];

describe("toSrt", () => {
	it("bilingual mode stacks source and translation", () => {
		const srt = toSrt(cues, "bilingual");
		expect(srt).toContain(
			"1\n00:00:00,000 --> 00:00:02,000\nHello world.\n你好,世界。",
		);
		expect(srt).toContain(
			"2\n00:00:03,000 --> 00:00:05,000\nNo translation yet.",
		);
		expect(srt.endsWith("\n")).toBe(true);
	});
	it("target mode falls back to source when missing", () => {
		const srt = toSrt(cues, "target");
		expect(srt).toContain("你好,世界。");
		expect(srt).toContain("No translation yet.");
		expect(srt).not.toContain("Hello world.");
	});
	it("source mode emits original only", () => {
		const srt = toSrt(cues, "source");
		expect(srt).not.toContain("你好");
	});
});

describe("srtFilename", () => {
	it("encodes mode and language", () => {
		expect(srtFilename("123", "bilingual", "zh-CN")).toBe(
			"x-video-123.bi-zh-CN.srt",
		);
		expect(srtFilename("123", "source", "zh-CN")).toBe("x-video-123.orig.srt");
		expect(srtFilename("123", "target", "zh-CN")).toBe("x-video-123.zh-CN.srt");
	});

	it("tags the engine when given, sanitising it for a filename", () => {
		expect(srtFilename("123", "bilingual", "zh-CN", "gemini-3.5-flash")).toBe(
			"x-video-123.bi-zh-CN.gemini-3.5-flash.srt",
		);
		expect(srtFilename("123", "bilingual", "zh-CN", "gpt-4.1-mini")).toBe(
			"x-video-123.bi-zh-CN.gpt-4.1-mini.srt",
		);
		expect(srtFilename("123", "bilingual", "zh-CN", "weird/model name")).toBe(
			"x-video-123.bi-zh-CN.weird-model-name.srt",
		);
	});
});
