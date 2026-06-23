export interface FetchRetryOptions {
	/** Attempts including the first one. */
	attempts?: number;
	/** Per-attempt timeout in ms. */
	timeoutMs?: number;
	/** Base backoff in ms (exponential, jittered). */
	backoffMs?: number;
	signal?: AbortSignal;
	/** Retry on these HTTP statuses (besides network errors). */
	retryStatuses?: number[];
}

const DEFAULTS: Required<Omit<FetchRetryOptions, "signal">> = {
	attempts: 3,
	timeoutMs: 60_000,
	backoffMs: 800,
	retryStatuses: [408, 429, 500, 502, 503, 504],
};

export async function fetchRetry(
	input: string,
	init: RequestInit,
	opts: FetchRetryOptions = {},
): Promise<Response> {
	const { attempts, timeoutMs, backoffMs, retryStatuses } = {
		...DEFAULTS,
		...opts,
	};
	let lastErr: unknown;
	for (let i = 0; i < attempts; i++) {
		const ctrl = new AbortController();
		const timer = setTimeout(
			() => ctrl.abort(new DOMException("timeout", "TimeoutError")),
			timeoutMs,
		);
		const onOuterAbort = () => ctrl.abort(opts.signal?.reason);
		opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
		try {
			if (opts.signal?.aborted)
				throw opts.signal.reason ?? new DOMException("aborted", "AbortError");
			const res = await fetch(input, { ...init, signal: ctrl.signal });
			if (retryStatuses.includes(res.status) && i < attempts - 1) {
				lastErr = new Error(`HTTP ${res.status}`);
			} else {
				return res;
			}
		} catch (e) {
			if (opts.signal?.aborted) throw e;
			lastErr = e;
			if (i === attempts - 1) throw e;
		} finally {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onOuterAbort);
		}
		await new Promise((r) =>
			setTimeout(r, backoffMs * 2 ** i * (0.7 + Math.random() * 0.6)),
		);
	}
	throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function readErrorBody(res: Response): Promise<string> {
	try {
		const text = await res.text();
		return text.slice(0, 500);
	} catch {
		return "";
	}
}
