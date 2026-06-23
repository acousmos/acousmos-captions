import { describe, expect, it } from "vitest";
import { adtsHeader, fragmentToAdts, parseAacConfig } from "../src/core/fmp4";

// --- tiny ISO-BMFF box builders for synthetic fixtures ---
function box(type: string, payload: number[]): number[] {
	const size = 8 + payload.length;
	return [
		(size >>> 24) & 0xff,
		(size >>> 16) & 0xff,
		(size >>> 8) & 0xff,
		size & 0xff,
		...ascii(type),
		...payload,
	];
}
function ascii(s: string): number[] {
	return [...s].map((c) => c.charCodeAt(0));
}
function u32(n: number): number[] {
	return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

// AAC-LC, 44.1kHz, mono → ASC 0x12 0x08 (matches real X audio renditions).
const CFG = { aot: 2, freqIdx: 4, chan: 1 };

function syntheticInit(): Uint8Array {
	const esds = box("esds", [
		0,
		0,
		0,
		0, // version/flags
		0x03,
		0x19,
		0x00,
		0x01,
		0x00, // ES_Descriptor: tag,len, ES_ID(2)+flags(1)
		0x04,
		0x11,
		...new Array(13).fill(0), // DecoderConfigDescriptor: tag,len, 13 bytes
		0x05,
		0x02,
		0x12,
		0x08, // DecoderSpecificInfo: tag,len, ASC
	]);
	const mp4a = box("mp4a", [...new Array(28).fill(0), ...esds]); // 28 audio fields + esds
	const stsd = box("stsd", [0, 0, 0, 0, ...u32(1), ...mp4a]); // version/flags + count + entry
	const stbl = box("stbl", stsd);
	const minf = box("minf", stbl);
	const mdia = box("mdia", minf);
	const trak = box("trak", mdia);
	const moov = box("moov", trak);
	return Uint8Array.from([...box("ftyp", ascii("isom")), ...moov]);
}

function syntheticFragment(sizes: number[]): Uint8Array {
	const tfhd = box("tfhd", [0, 0, 0, 0, ...u32(1)]); // flags 0, track_id
	const trun = box("trun", [
		0,
		0,
		0x02,
		0x00,
		...u32(sizes.length),
		...sizes.flatMap(u32),
	]); // flag 0x200 (size)
	const traf = box("traf", [...tfhd, ...trun]);
	const moof = box("moof", traf);
	const total = sizes.reduce((a, b) => a + b, 0);
	// mdat payload: distinguishable bytes per sample
	const data: number[] = [];
	sizes.forEach((sz, i) => data.push(...new Array(sz).fill(i + 1)));
	expect(data.length).toBe(total);
	const mdat = box("mdat", data);
	return Uint8Array.from([...box("styp", ascii("msdh")), ...moof, ...mdat]);
}

describe("adtsHeader", () => {
	it("matches the bytes validated against real X audio (frame len 93)", () => {
		expect([...adtsHeader(CFG, 93)]).toEqual([
			0xff, 0xf1, 0x50, 0x40, 0x0c, 0x9f, 0xfc,
		]);
	});
	it("encodes frame length across the split fields", () => {
		const h = adtsHeader(CFG, 1); // total len 8
		const len = ((h[3]! & 0x03) << 11) | (h[4]! << 3) | (h[5]! >> 5);
		expect(len).toBe(8);
	});
});

describe("parseAacConfig", () => {
	it("extracts AOT / freqIdx / channels from an fMP4 init esds", () => {
		expect(parseAacConfig(syntheticInit())).toEqual(CFG);
	});
	it("returns null when there is no mp4a/esds", () => {
		expect(
			parseAacConfig(Uint8Array.from(box("ftyp", ascii("isom")))),
		).toBeNull();
	});
});

describe("fragmentToAdts", () => {
	it("wraps each sample in a 7-byte ADTS header and concatenates", () => {
		const out = fragmentToAdts(CFG, syntheticFragment([3, 4]));
		expect(out.length).toBe(3 + 7 + (4 + 7)); // 21
		// Frame 0
		expect(out[0]).toBe(0xff);
		expect(out[1]! & 0xf6).toBe(0xf0); // sync + layer + no-CRC bits
		expect([...out.subarray(7, 10)]).toEqual([1, 1, 1]); // sample 0 payload
		// Frame 1 begins right after frame 0 (7 + 3 = 10)
		expect(out[10]).toBe(0xff);
		expect([...out.subarray(17, 21)]).toEqual([2, 2, 2, 2]); // sample 1 payload
	});

	it("produces a stream whose ADTS frame lengths walk exactly to the end", () => {
		const out = fragmentToAdts(CFG, syntheticFragment([10, 20, 30]));
		let pos = 0;
		let frames = 0;
		while (pos + 7 <= out.length) {
			expect(out[pos]).toBe(0xff);
			const len =
				((out[pos + 3]! & 0x03) << 11) |
				(out[pos + 4]! << 3) |
				(out[pos + 5]! >> 5);
			pos += len;
			frames++;
		}
		expect(frames).toBe(3);
		expect(pos).toBe(out.length);
	});
});
