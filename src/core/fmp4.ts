/**
 * Minimal fragmented-MP4 (fMP4) → ADTS-AAC remuxer.
 *
 * X serves video audio as an fMP4 AAC rendition (init.mp4 with a moov whose
 * sample tables are empty + .m4s fragments carrying samples in moof/trun/mdat).
 * Some ASR backends (e.g. Soniox) only accept self-describing containers
 * (aac/wav/mp3/…) and reject fMP4 with "no audio streams found", because the
 * init's moov advertises a track with no samples. Re-wrapping each AAC access
 * unit in a 7-byte ADTS header produces a plain `.aac` stream every recognizer
 * accepts. Validated against real X bytes before shipping.
 *
 * Only AAC is handled; callers fall back to the raw container otherwise.
 */

export interface AacConfig {
	/** AudioObjectType (2 = AAC-LC). */
	aot: number;
	/** Sampling frequency index (0–15). */
	freqIdx: number;
	/** Channel configuration (1 = mono, 2 = stereo). */
	chan: number;
}

const dvOf = (b: Uint8Array): DataView =>
	new DataView(b.buffer, b.byteOffset, b.byteLength);

interface Box {
	start: number;
	end: number;
	payloadStart: number;
}

function findBox(
	buf: Uint8Array,
	type: string,
	start: number,
	end: number,
): Box | null {
	const dv = dvOf(buf);
	let o = start;
	while (o + 8 <= end) {
		const size = dv.getUint32(o);
		const t = String.fromCharCode(
			buf[o + 4]!,
			buf[o + 5]!,
			buf[o + 6]!,
			buf[o + 7]!,
		);
		if (t === type) return { start: o, end: o + size, payloadStart: o + 8 };
		if (size < 8) break;
		o += size;
	}
	return null;
}

/** Descend a container path (each box's payload contains the next). */
function findPath(buf: Uint8Array, path: string[]): Box | null {
	let payloadStart = 0;
	let end = buf.length;
	let box: Box | null = null;
	for (const t of path) {
		box = findBox(buf, t, payloadStart, end);
		if (!box) return null;
		payloadStart = box.payloadStart;
		end = box.end;
	}
	return box;
}

/** Extract the AAC config from an fMP4 init segment's esds, or null if not AAC. */
export function parseAacConfig(init: Uint8Array): AacConfig | null {
	const stsd = findPath(init, ["moov", "trak", "mdia", "minf", "stbl", "stsd"]);
	if (!stsd) return null;
	// stsd payload: 4 (version/flags) + 4 (entry count) then sample entries.
	const mp4a = findBox(init, "mp4a", stsd.payloadStart + 8, stsd.end);
	if (!mp4a) return null;
	// mp4a sample entry: 8 (header) + 28 (audio fields) then child boxes (esds).
	const esds = findBox(init, "esds", mp4a.payloadStart + 28, mp4a.end);
	if (!esds) return null;

	// esds payload: 4 (version/flags) then descriptors. Walk to the
	// DecoderSpecificInfo (tag 0x05) which holds the AudioSpecificConfig.
	let o = esds.payloadStart + 4;
	let asc: Uint8Array | null = null;
	while (o < esds.end) {
		const tag = init[o++]!;
		let len = 0;
		let b: number;
		do {
			b = init[o++]!;
			len = (len << 7) | (b & 0x7f);
		} while (b & 0x80);
		if (tag === 0x05) {
			asc = init.slice(o, o + len);
			break;
		}
		if (tag === 0x03)
			o += 3; // ES_Descriptor: ES_ID(2) + flags(1), then nested
		else if (tag === 0x04)
			o += 13; // DecoderConfigDescriptor: 13 bytes, then nested DSI
		else o += len;
	}
	if (!asc || asc.length < 2) return null;
	return {
		aot: (asc[0]! >> 3) & 0x1f,
		freqIdx: ((asc[0]! & 0x07) << 1) | (asc[1]! >> 7),
		chan: (asc[1]! >> 3) & 0x0f,
	};
}

/** Per-sample byte sizes for one fragment (from trun, or tfhd default). */
function sampleSizes(frag: Uint8Array): number[] {
	const trun = findPath(frag, ["moof", "traf", "trun"]);
	if (!trun) return [];
	const tfhd = findPath(frag, ["moof", "traf", "tfhd"]);
	const dv = dvOf(frag);
	const flags = dv.getUint32(trun.payloadStart) & 0xffffff;
	const count = dv.getUint32(trun.payloadStart + 4);
	let p = trun.payloadStart + 8;
	if (flags & 0x000001) p += 4; // data_offset
	if (flags & 0x000004) p += 4; // first_sample_flags

	let defSize = 0;
	if (tfhd) {
		const tf = dv.getUint32(tfhd.payloadStart) & 0xffffff;
		let q = tfhd.payloadStart + 8; // version/flags(4) + track_id(4)
		if (tf & 0x000001) q += 8; // base_data_offset
		if (tf & 0x000002) q += 4; // sample_description_index
		if (tf & 0x000008) q += 4; // default_sample_duration
		if (tf & 0x000010) defSize = dv.getUint32(q); // default_sample_size
	}

	let stride = 0;
	if (flags & 0x000100) stride += 4; // duration
	if (flags & 0x000200) stride += 4; // size
	if (flags & 0x000400) stride += 4; // flags
	if (flags & 0x000800) stride += 4; // composition offset

	const sizes: number[] = [];
	for (let i = 0; i < count; i++) {
		let sz = defSize;
		if (flags & 0x000200) sz = dv.getUint32(p + (flags & 0x000100 ? 4 : 0));
		p += stride;
		sizes.push(sz);
	}
	return sizes;
}

/** 7-byte ADTS header (no CRC) for one AAC frame of `aacFrameLen` bytes. */
export function adtsHeader(cfg: AacConfig, aacFrameLen: number): Uint8Array {
	const len = aacFrameLen + 7;
	const profile = cfg.aot - 1; // ADTS profile = AOT - 1
	return Uint8Array.from([
		0xff,
		0xf1, // syncword + MPEG-4 + no CRC
		(profile << 6) | (cfg.freqIdx << 2) | ((cfg.chan >> 2) & 0x01),
		((cfg.chan & 0x03) << 6) | ((len >> 11) & 0x03),
		(len >> 3) & 0xff,
		((len & 0x07) << 5) | 0x1f,
		0xfc, // buffer fullness + 0 frames-1
	]);
}

/** Convert one fMP4 fragment's AAC samples into concatenated ADTS frames. */
export function fragmentToAdts(cfg: AacConfig, frag: Uint8Array): Uint8Array {
	const sizes = sampleSizes(frag);
	const mdat = findBox(frag, "mdat", 0, frag.length);
	if (!mdat || sizes.length === 0) return new Uint8Array(0);
	const total = sizes.reduce((n, s) => n + s + 7, 0);
	const out = new Uint8Array(total);
	let inOff = mdat.payloadStart;
	let outOff = 0;
	for (const sz of sizes) {
		out.set(adtsHeader(cfg, sz), outOff);
		outOff += 7;
		out.set(frag.subarray(inOff, inOff + sz), outOff);
		outOff += sz;
		inOff += sz;
	}
	return outOff === total ? out : out.subarray(0, outOff);
}
