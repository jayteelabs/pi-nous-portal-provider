import type { Api, Model } from "@mariozechner/pi-ai";
import {
	DEFAULT_INFERENCE_BASE_URL,
	DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
	OPENAI_COMPAT,
	PROVIDER_ID,
	buildFallbackModels,
	coerceStoredCatalog,
	fetchModelCatalog,
	isModelCatalogAuthError,
	normalizeBaseUrl,
	type NousProviderModelConfig,
} from "./models.ts";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type CatalogPolicyCredentials = {
	access?: unknown;
	expires?: unknown;
	inferenceBaseUrl?: unknown;
	modelCatalog?: unknown;
	modelCatalogUnavailable?: unknown;
};

export type ResolveDirectCatalogOptions = {
	apiKey?: string;
	baseUrl?: string;
	fetchFn?: FetchLike;
	timeoutMs?: number;
	openRouterMetadataTimeoutMs?: number;
	openRouterModelsUrl?: string;
	signal?: AbortSignal;
};

export type RefreshOAuthCatalogOptions = {
	apiKey: string;
	baseUrl?: string;
	fetchFn?: FetchLike;
	timeoutMs?: number;
	openRouterMetadataTimeoutMs?: number;
	openRouterModelsUrl?: string;
	signal?: AbortSignal;
	now?: () => number;
};

export type OAuthCatalogRefreshResult = {
	catalog?: NousProviderModelConfig[];
	unavailable: boolean;
	fetchedAt?: number;
};

export type StoredCatalogSelectionOptions = {
	now?: () => number;
};

function credentialExpiry(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value === "string" && value.trim()) return Number(value);
	return NaN;
}

export function credentialsHaveUsableAgentKey(
	credentials: CatalogPolicyCredentials = {},
	options: StoredCatalogSelectionOptions = {},
): boolean {
	const access = typeof credentials.access === "string" && credentials.access.trim().length > 0;
	const expires = credentialExpiry(credentials.expires);
	return access && Number.isFinite(expires) && expires > (options.now ?? Date.now)();
}

export async function resolveDirectCatalog(options: ResolveDirectCatalogOptions = {}): Promise<NousProviderModelConfig[]> {
	const apiKey = options.apiKey?.trim();
	const baseUrl = normalizeBaseUrl(options.baseUrl, DEFAULT_INFERENCE_BASE_URL);
	if (!apiKey) return [];

	try {
		return await fetchModelCatalog(apiKey, baseUrl, {
			fetchFn: options.fetchFn,
			timeoutMs: options.timeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
			openRouterMetadataTimeoutMs: options.openRouterMetadataTimeoutMs,
			openRouterModelsUrl: options.openRouterModelsUrl,
			signal: options.signal,
		});
	} catch (error) {
		if (isModelCatalogAuthError(error)) return [];
		return buildFallbackModels(baseUrl);
	}
}

export async function refreshOAuthCatalog(options: RefreshOAuthCatalogOptions): Promise<OAuthCatalogRefreshResult> {
	const baseUrl = normalizeBaseUrl(options.baseUrl, DEFAULT_INFERENCE_BASE_URL);
	try {
		const catalog = await fetchModelCatalog(options.apiKey, baseUrl, {
			fetchFn: options.fetchFn,
			timeoutMs: options.timeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
			openRouterMetadataTimeoutMs: options.openRouterMetadataTimeoutMs,
			openRouterModelsUrl: options.openRouterModelsUrl,
			signal: options.signal,
		});
		return { catalog, unavailable: false, fetchedAt: (options.now ?? Date.now)() };
	} catch {
		return { unavailable: true };
	}
}

export function selectStoredCredentialCatalog(
	credentials: CatalogPolicyCredentials = {},
	options: StoredCatalogSelectionOptions = {},
): NousProviderModelConfig[] {
	const baseUrl = normalizeBaseUrl(credentials.inferenceBaseUrl, DEFAULT_INFERENCE_BASE_URL);
	if (!credentialsHaveUsableAgentKey(credentials, options)) return [];

	const storedCatalog = coerceStoredCatalog(credentials.modelCatalog);
	if (storedCatalog.length > 0) return storedCatalog.map((model) => ({ ...model, baseUrl }));

	if (credentials.modelCatalogUnavailable === true) return buildFallbackModels(baseUrl);

	return [];
}

function toProviderModels(catalog: NousProviderModelConfig[], baseUrl: string): Model<Api>[] {
	return catalog.map(
		(model) =>
			({
				...model,
				provider: PROVIDER_ID,
				api: "openai-completions",
				baseUrl,
				compat: { ...OPENAI_COMPAT, ...(model.compat ?? {}) },
			}) as Model<Api>,
	);
}

export function applyCatalogToProviderModels(
	models: Model<Api>[],
	credentials: CatalogPolicyCredentials = {},
	options: StoredCatalogSelectionOptions = {},
): Model<Api>[] {
	const baseUrl = normalizeBaseUrl(credentials.inferenceBaseUrl, DEFAULT_INFERENCE_BASE_URL);
	const nonNousModels = models.filter((model) => model.provider !== PROVIDER_ID);
	const credentialModels = selectStoredCredentialCatalog(credentials, options);
	if (credentialModels.length === 0) return nonNousModels;
	return [...nonNousModels, ...toProviderModels(credentialModels, baseUrl)];
}
