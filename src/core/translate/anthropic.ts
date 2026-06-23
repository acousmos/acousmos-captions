import { JobError } from "../../shared/types";
import { fetchRetry, readErrorBody } from "../../shared/net";
import { extractItems, ITEMS_SCHEMA, systemPrompt, userPrompt } from "./prompt";
import type {
	BatchItem,
	TranslateContext,
	TranslateOptions,
	TranslateProvider,
} from "./types";

const API = "https://api.anthropic.com/v1";
// Required headers for calling the Messages API directly from a browser
// context with a user-provided key (per Anthropic docs).
const VERSION_HEADERS = {
	"anthropic-version": "2023-06-01",
	"anthropic-dangerous-direct-browser-access": "true",
};

interface MessagesResponse {
	content?: { type: string; text?: string }[];
}

export const anthropic: TranslateProvider = {
	id: "anthropic",

	async translateBatch(
		items: BatchItem[],
		ctx: TranslateContext,
		opts: TranslateOptions,
	): Promise<BatchItem[]> {
		const body: Record<string, unknown> = {
			model: opts.model,
			max_tokens: 8192,
			system: systemPrompt(ctx.targetLang, ctx.glossary),
			messages: [{ role: "user", content: userPrompt(items, ctx) }],
			// Structured outputs anchor each translation to its cue id.
			output_config: { format: { type: "json_schema", schema: ITEMS_SCHEMA } },
		};
		let res = await postMessages(body, opts);
		if (res.status === 400) {
			// Older/unsupported models may reject output_config — retry on prompt discipline alone.
			delete body["output_config"];
			res = await postMessages(body, opts);
		}
		if (res.status === 401 || res.status === 403)
			throw new JobError("err_llm_auth", await readErrorBody(res));
		if (!res.ok)
			throw new JobError(
				"err_llm_failed",
				`Anthropic HTTP ${res.status}: ${await readErrorBody(res)}`,
			);
		const data = (await res.json()) as MessagesResponse;
		const text =
			data.content
				?.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join("") ?? "";
		return extractItems(text);
	},

	async testKey(key: string): Promise<boolean> {
		const res = await fetch(`${API}/models?limit=1`, {
			headers: { "x-api-key": key, ...VERSION_HEADERS },
		});
		return res.ok;
	},
};

function postMessages(
	body: Record<string, unknown>,
	opts: TranslateOptions,
): Promise<Response> {
	return fetchRetry(
		`${API}/messages`,
		{
			method: "POST",
			headers: {
				"x-api-key": opts.key,
				"Content-Type": "application/json",
				...VERSION_HEADERS,
			},
			body: JSON.stringify(body),
		},
		{
			signal: opts.signal,
			timeoutMs: 120_000,
			retryStatuses: [408, 429, 500, 502, 503, 504, 529],
		},
	);
}
