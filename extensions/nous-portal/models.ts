import type { Api, Model } from "@mariozechner/pi-ai";

export const PROVIDER_ID = "nous-portal";
export const PROVIDER_NAME = "Nous Research Portal";
export const DEFAULT_INFERENCE_BASE_URL = "https://inference-api.nousresearch.com/v1";
export const DEFAULT_OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 3000;
export const DEFAULT_OPENROUTER_METADATA_TIMEOUT_MS = 3000;
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

export type RawCatalogModel =
	| string
	| {
			id?: unknown;
			name?: unknown;
			reasoning?: unknown;
			context_window?: unknown;
			contextWindow?: unknown;
			context_length?: unknown;
			contextLength?: unknown;
			context_length_tokens?: unknown;
			max_tokens?: unknown;
			maxTokens?: unknown;
			max_output_tokens?: unknown;
			maxOutputTokens?: unknown;
			max_completion_tokens?: unknown;
			supported_parameters?: unknown;
			input?: unknown;
			inputs?: unknown;
			modalities?: unknown;
			input_modalities?: unknown;
			architecture?: unknown;
			top_provider?: unknown;
			pricing?: unknown;
	  };

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const PRICE_PER_TOKEN_TO_MTOK = 1_000_000;

const OPENROUTER_REASONING_EFFORT_MAP = {
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
};

export const OPENAI_COMPAT: NonNullable<NousProviderModelConfig["compat"]> = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: false,
	maxTokensField: "max_tokens",
};

export const OPENROUTER_REASONING_COMPAT: NonNullable<NousProviderModelConfig["compat"]> = {
	...OPENAI_COMPAT,
	supportsReasoningEffort: false,
	thinkingFormat: "openrouter",
	reasoningEffortMap: { ...OPENROUTER_REASONING_EFFORT_MAP },
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

function coercePricePerMillionTokens(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value * PRICE_PER_TOKEN_TO_MTOK;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed * PRICE_PER_TOKEN_TO_MTOK;
	}
	return 0;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase())
		: [];
}

function getTopProvider(raw: RawCatalogModel): Record<string, unknown> {
	return typeof raw === "string" ? {} : asRecord(raw.top_provider);
}

function getArchitecture(raw: RawCatalogModel): Record<string, unknown> {
	return typeof raw === "string" ? {} : asRecord(raw.architecture);
}

function getPricing(raw: RawCatalogModel): Record<string, unknown> {
	return typeof raw === "string" ? {} : asRecord(raw.pricing);
}

function explicitInputModalities(raw: RawCatalogModel): string[] | undefined {
	if (typeof raw === "string") return undefined;

	const candidates = [
		raw.input,
		raw.inputs,
		raw.input_modalities,
		getArchitecture(raw).input_modalities,
	];
	for (const value of candidates) {
		const modalities = asStringArray(value);
		if (modalities.length > 0) return modalities;
	}

	const modalities = raw.modalities;
	if (Array.isArray(modalities)) return asStringArray(modalities);
	const modalityInput = asRecord(modalities).input;
	const modalityInputValues = asStringArray(modalityInput);
	return modalityInputValues.length > 0 ? modalityInputValues : undefined;
}

function inferStaticInputs(id: string): ("text" | "image")[] {
	const lower = id.toLowerCase();
	if (
		lower.startsWith("anthropic/claude-") ||
		lower.startsWith("google/gemini-") ||
		lower.startsWith("x-ai/grok-") ||
		lower === "moonshotai/kimi-k2.6" ||
		lower.includes("glm-5v") ||
		lower.startsWith("qwen/qwen3.5-")
	) {
		return ["text", "image"];
	}
	return ["text"];
}

function inferInputs(raw: RawCatalogModel, id: string): ("text" | "image")[] {
	const modalities = explicitInputModalities(raw);
	if (modalities) {
		return modalities.includes("image") ? ["text", "image"] : ["text"];
	}
	return inferStaticInputs(id);
}

function supportedParameters(raw: RawCatalogModel): string[] {
	return typeof raw === "string" ? [] : asStringArray(raw.supported_parameters);
}

function inferStaticReasoning(id: string): boolean {
	const lower = id.toLowerCase();
	return (
		lower.includes("thinking") ||
		lower.includes("reasoning") ||
		lower.includes("reasoner") ||
		lower.startsWith("anthropic/claude-opus-4") ||
		lower.startsWith("anthropic/claude-sonnet-4") ||
		lower.startsWith("anthropic/claude-haiku-4") ||
		lower.startsWith("moonshotai/kimi-k2") ||
		lower.startsWith("openai/gpt-5") ||
		lower.startsWith("google/gemini-2.5") ||
		lower.startsWith("google/gemini-3") ||
		lower.startsWith("qwen/qwen3") ||
		lower.startsWith("xiaomi/mimo-") ||
		lower.startsWith("x-ai/") ||
		lower.startsWith("deepseek/") ||
		lower.startsWith("z-ai/glm-5") ||
		lower.startsWith("nvidia/nemotron-3") ||
		lower === "tencent/hy3-preview"
	);
}

function inferReasoning(raw: RawCatalogModel, id: string): boolean {
	if (typeof raw !== "string") {
		const params = supportedParameters(raw);
		if (params.length > 0) return params.includes("reasoning") || params.includes("include_reasoning");
		if (typeof raw.reasoning === "boolean") return raw.reasoning;
	}
	return inferStaticReasoning(id);
}

function rawModelId(raw: RawCatalogModel): string | undefined {
	const value = typeof raw === "string" ? raw : raw.id;
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function rawModelName(raw: RawCatalogModel, id: string): string {
	if (typeof raw !== "string" && typeof raw.name === "string" && raw.name.trim()) return raw.name.trim();
	return id;
}

function rawContextWindow(raw: RawCatalogModel): number {
	if (typeof raw === "string") return DEFAULT_CONTEXT_WINDOW;
	const topProvider = getTopProvider(raw);
	return (
		coercePositiveInteger(topProvider.context_length) ??
		coercePositiveInteger(raw.context_window) ??
		coercePositiveInteger(raw.contextWindow) ??
		coercePositiveInteger(raw.context_length) ??
		coercePositiveInteger(raw.contextLength) ??
		coercePositiveInteger(raw.context_length_tokens) ??
		DEFAULT_CONTEXT_WINDOW
	);
}

function rawMaxTokens(raw: RawCatalogModel): number {
	if (typeof raw === "string") return DEFAULT_MAX_TOKENS;
	const topProvider = getTopProvider(raw);
	return (
		coercePositiveInteger(topProvider.max_completion_tokens) ??
		coercePositiveInteger(raw.max_completion_tokens) ??
		coercePositiveInteger(raw.max_tokens) ??
		coercePositiveInteger(raw.maxTokens) ??
		coercePositiveInteger(raw.max_output_tokens) ??
		coercePositiveInteger(raw.maxOutputTokens) ??
		DEFAULT_MAX_TOKENS
	);
}

function rawCost(raw: RawCatalogModel): NousProviderModelConfig["cost"] {
	const pricing = getPricing(raw);
	if (Object.keys(pricing).length === 0) return { ...ZERO_COST };
	return {
		input: coercePricePerMillionTokens(pricing.prompt),
		output: coercePricePerMillionTokens(pricing.completion),
		cacheRead: coercePricePerMillionTokens(pricing.input_cache_read),
		cacheWrite: coercePricePerMillionTokens(pricing.input_cache_write),
	};
}

function modelCompat(reasoning: boolean): NonNullable<NousProviderModelConfig["compat"]> {
	return reasoning ? { ...OPENROUTER_REASONING_COMPAT } : { ...OPENAI_COMPAT };
}

export function toNousModelConfig(raw: RawCatalogModel, baseUrl: string): NousProviderModelConfig | undefined {
	const id = rawModelId(raw);
	if (!id) return undefined;
	const reasoning = inferReasoning(raw, id);

	return {
		id,
		name: rawModelName(raw, id),
		api: "openai-completions",
		baseUrl: normalizeBaseUrl(baseUrl),
		reasoning,
		input: inferInputs(raw, id),
		cost: rawCost(raw),
		contextWindow: rawContextWindow(raw),
		maxTokens: rawMaxTokens(raw),
		compat: modelCompat(reasoning),
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

export function parseOpenRouterModelMetadata(payload: unknown): Map<string, RawCatalogModel> {
	const data =
		typeof payload === "object" && payload !== null && Array.isArray((payload as { data?: unknown }).data)
			? ((payload as { data: RawCatalogModel[] }).data as RawCatalogModel[])
			: [];
	const metadata = new Map<string, RawCatalogModel>();
	for (const raw of data) {
		const id = rawModelId(raw);
		if (id && !metadata.has(id)) metadata.set(id, raw);
	}
	return metadata;
}

export function applyOpenRouterMetadata(
	models: NousProviderModelConfig[],
	metadata: Map<string, RawCatalogModel>,
): NousProviderModelConfig[] {
	return models.map((model) => {
		const raw = metadata.get(model.id);
		if (!raw) return model;
		const enriched = toNousModelConfig({ ...asRecord(raw), id: model.id }, model.baseUrl ?? DEFAULT_INFERENCE_BASE_URL);
		if (!enriched) return model;
		return {
			...model,
			...enriched,
			id: model.id,
			api: "openai-completions",
			baseUrl: model.baseUrl,
			compat: { ...OPENAI_COMPAT, ...(enriched.compat ?? {}) },
		};
	});
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
		openRouterMetadataTimeoutMs?: number;
		openRouterModelsUrl?: string;
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
		const models = parseModelCatalog(await response.json(), normalizedBaseUrl);
		return enrichModelsWithOpenRouterMetadata(models, {
			fetchFn,
			openRouterModelsUrl: options.openRouterModelsUrl,
			timeoutMs: options.openRouterMetadataTimeoutMs ?? DEFAULT_OPENROUTER_METADATA_TIMEOUT_MS,
			signal: options.signal,
		});
	} finally {
		cleanup();
	}
}

export async function fetchOpenRouterModelMetadata(
	options: {
		fetchFn?: FetchLike;
		openRouterModelsUrl?: string;
		timeoutMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<Map<string, RawCatalogModel>> {
	const fetchFn = options.fetchFn ?? fetch;
	const modelsUrl = normalizeBaseUrl(options.openRouterModelsUrl, DEFAULT_OPENROUTER_MODELS_URL);
	const { signal, cleanup } = createTimeoutSignal(
		options.timeoutMs ?? DEFAULT_OPENROUTER_METADATA_TIMEOUT_MS,
		options.signal,
	);
	try {
		const response = await fetchFn(modelsUrl, {
			method: "GET",
			headers: { Accept: "application/json" },
			signal,
		});
		if (!response.ok) throw new Error(`OpenRouter /models request failed with status ${response.status}`);
		return parseOpenRouterModelMetadata(await response.json());
	} finally {
		cleanup();
	}
}

export async function enrichModelsWithOpenRouterMetadata(
	models: NousProviderModelConfig[],
	options: {
		fetchFn?: FetchLike;
		openRouterModelsUrl?: string;
		timeoutMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<NousProviderModelConfig[]> {
	if (models.length === 0) return models;
	try {
		const metadata = await fetchOpenRouterModelMetadata(options);
		return applyOpenRouterMetadata(models, metadata);
	} catch {
		return models;
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
