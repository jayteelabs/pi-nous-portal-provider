import type { Api, Model } from "@mariozechner/pi-ai";

export const PROVIDER_ID = "nous-portal";
export const PROVIDER_NAME = "Nous Research Portal";
export const DEFAULT_INFERENCE_BASE_URL = "https://inference-api.nousresearch.com/v1";
export const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 3000;
export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_TOKENS = 4096;

export type NousProviderModelConfig = {
	id: string;
	name: string;
	api?: "openai-completions";
	baseUrl?: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	compat?: Model<Api>["compat"];
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type RawCatalogModel =
	| string
	| {
			id?: unknown;
			name?: unknown;
			context_window?: unknown;
			contextWindow?: unknown;
			context_length?: unknown;
			contextLength?: unknown;
			max_tokens?: unknown;
			maxTokens?: unknown;
			max_output_tokens?: unknown;
			maxOutputTokens?: unknown;
			input?: unknown;
			inputs?: unknown;
			modalities?: unknown;
			input_modalities?: unknown;
	  };

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const OPENAI_COMPAT: NonNullable<NousProviderModelConfig["compat"]> = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: false,
	maxTokensField: "max_tokens",
};

export const FALLBACK_MODEL_IDS = [
	"moonshotai/kimi-k2.6",
	"xiaomi/mimo-v2.5-pro",
	"xiaomi/mimo-v2.5",
	"tencent/hy3-preview",
	"anthropic/claude-opus-4.7",
	"anthropic/claude-opus-4.6",
	"anthropic/claude-sonnet-4.6",
	"anthropic/claude-sonnet-4.5",
	"anthropic/claude-haiku-4.5",
	"openai/gpt-5.5",
	"openai/gpt-5.4-mini",
	"openai/gpt-5.3-codex",
	"google/gemini-3-pro-preview",
	"google/gemini-3-flash-preview",
	"google/gemini-3.1-pro-preview",
	"google/gemini-3.1-flash-lite-preview",
	"qwen/qwen3.5-plus-02-15",
	"qwen/qwen3.5-35b-a3b",
	"stepfun/step-3.5-flash",
	"minimax/minimax-m2.7",
	"minimax/minimax-m2.5",
	"minimax/minimax-m2.5:free",
	"z-ai/glm-5.1",
	"z-ai/glm-5v-turbo",
	"z-ai/glm-5-turbo",
	"x-ai/grok-4.20-beta",
	"nvidia/nemotron-3-super-120b-a12b",
	"arcee-ai/trinity-large-thinking",
	"openai/gpt-5.5-pro",
	"openai/gpt-5.4-nano",
];

export function normalizeBaseUrl(value: unknown, fallback = DEFAULT_INFERENCE_BASE_URL): string {
	const candidate = typeof value === "string" && value.trim() ? value.trim() : fallback;
	return candidate.replace(/\/+$/, "");
}

export function getInferenceBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	return normalizeBaseUrl(env.NOUS_INFERENCE_BASE_URL, DEFAULT_INFERENCE_BASE_URL);
}

function coercePositiveInteger(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
	}
	return undefined;
}

function arrayHasImage(value: unknown): boolean {
	return Array.isArray(value) && value.some((item) => typeof item === "string" && item.toLowerCase() === "image");
}

function inferInputs(raw: RawCatalogModel): ("text" | "image")[] {
	if (typeof raw === "string") return ["text"];
	if (
		arrayHasImage(raw.input) ||
		arrayHasImage(raw.inputs) ||
		arrayHasImage(raw.modalities) ||
		arrayHasImage(raw.input_modalities)
	) {
		return ["text", "image"];
	}
	return ["text"];
}

function rawModelId(raw: RawCatalogModel): string | undefined {
	const value = typeof raw === "string" ? raw : raw.id;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function rawModelName(raw: RawCatalogModel, id: string): string {
	if (typeof raw !== "string" && typeof raw.name === "string" && raw.name.trim()) return raw.name.trim();
	return id;
}

export function toNousModelConfig(raw: RawCatalogModel, baseUrl: string): NousProviderModelConfig | undefined {
	const id = rawModelId(raw);
	if (!id) return undefined;
	const contextWindow =
		typeof raw === "string"
			? DEFAULT_CONTEXT_WINDOW
			: (coercePositiveInteger(raw.context_window) ??
				coercePositiveInteger(raw.contextWindow) ??
				coercePositiveInteger(raw.context_length) ??
				coercePositiveInteger(raw.contextLength) ??
				DEFAULT_CONTEXT_WINDOW);
	const maxTokens =
		typeof raw === "string"
			? DEFAULT_MAX_TOKENS
			: (coercePositiveInteger(raw.max_tokens) ??
				coercePositiveInteger(raw.maxTokens) ??
				coercePositiveInteger(raw.max_output_tokens) ??
				coercePositiveInteger(raw.maxOutputTokens) ??
				DEFAULT_MAX_TOKENS);

	return {
		id,
		name: rawModelName(raw, id),
		api: "openai-completions",
		baseUrl: normalizeBaseUrl(baseUrl),
		reasoning: false,
		input: inferInputs(raw),
		cost: { ...ZERO_COST },
		contextWindow,
		maxTokens,
		compat: { ...OPENAI_COMPAT },
	};
}

export function parseModelCatalog(payload: unknown, baseUrl: string): NousProviderModelConfig[] {
	const data =
		typeof payload === "object" && payload !== null && Array.isArray((payload as { data?: unknown }).data)
			? ((payload as { data: RawCatalogModel[] }).data as RawCatalogModel[])
			: [];
	const models: NousProviderModelConfig[] = [];
	const seen = new Set<string>();
	for (const raw of data) {
		const model = toNousModelConfig(raw, baseUrl);
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	return models;
}

export function buildFallbackModels(baseUrl = DEFAULT_INFERENCE_BASE_URL): NousProviderModelConfig[] {
	return FALLBACK_MODEL_IDS.map((id) => toNousModelConfig(id, baseUrl)).filter((model): model is NousProviderModelConfig =>
		Boolean(model),
	);
}

function createTimeoutSignal(timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const abortFromParent = () => controller.abort(parent?.reason);
	if (parent?.aborted) controller.abort(parent.reason);
	else parent?.addEventListener("abort", abortFromParent, { once: true });
	if (timeoutMs > 0) timeout = setTimeout(() => controller.abort(new Error("Model discovery timed out")), timeoutMs);
	return {
		signal: controller.signal,
		cleanup: () => {
			if (timeout) clearTimeout(timeout);
			parent?.removeEventListener("abort", abortFromParent);
		},
	};
}

export async function fetchModelCatalog(
	apiKey: string,
	baseUrl = DEFAULT_INFERENCE_BASE_URL,
	options: {
		fetchFn?: FetchLike;
		timeoutMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<NousProviderModelConfig[]> {
	if (!apiKey.trim()) return [];
	const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
	const fetchFn = options.fetchFn ?? fetch;
	const { signal, cleanup } = createTimeoutSignal(options.timeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS, options.signal);
	try {
		const response = await fetchFn(`${normalizedBaseUrl}/models`, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			signal,
		});
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`/models request failed with status ${response.status}${text ? `: ${text}` : ""}`);
		}
		return parseModelCatalog(await response.json(), normalizedBaseUrl);
	} finally {
		cleanup();
	}
}

function isProviderModelConfig(value: unknown): value is NousProviderModelConfig {
	if (typeof value !== "object" || value === null) return false;
	const model = value as Partial<NousProviderModelConfig>;
	return (
		typeof model.id === "string" &&
		model.id.length > 0 &&
		typeof model.name === "string" &&
		typeof model.reasoning === "boolean" &&
		Array.isArray(model.input) &&
		typeof model.contextWindow === "number" &&
		typeof model.maxTokens === "number"
	);
}

export function coerceStoredCatalog(value: unknown): NousProviderModelConfig[] {
	if (!Array.isArray(value)) return [];
	return value.filter(isProviderModelConfig);
}

export function applyStoredModelCatalog(models: Model<Api>[], credentials: { [key: string]: unknown }): Model<Api>[] {
	const baseUrl = normalizeBaseUrl(credentials.inferenceBaseUrl, DEFAULT_INFERENCE_BASE_URL);
	const storedCatalog = coerceStoredCatalog(credentials.modelCatalog);
	if (storedCatalog.length === 0) {
		return models.map((model) => (model.provider === PROVIDER_ID ? { ...model, baseUrl } : model));
	}

	const nonNousModels = models.filter((model) => model.provider !== PROVIDER_ID);
	const liveNousModels = storedCatalog.map(
		(model) =>
			({
				...model,
				provider: PROVIDER_ID,
				api: "openai-completions",
				baseUrl,
				compat: { ...OPENAI_COMPAT, ...(model.compat ?? {}) },
			}) as Model<Api>,
	);
	return [...nonNousModels, ...liveNousModels];
}
