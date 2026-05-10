import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import {
	DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
	PROVIDER_ID,
	PROVIDER_NAME,
	applyStoredModelCatalog,
	buildFallbackModels,
	fetchModelCatalog,
	getInferenceBaseUrl,
	isModelCatalogAuthError,
	modelsForStoredCredentials,
	normalizeBaseUrl,
	type NousProviderModelConfig,
} from "./models.ts";
import {
	getNousPortalApiKey,
	loginNousPortal,
	refreshNousPortalCredentials,
} from "./auth.ts";

type AuthStorageLike = {
	get?: (provider: string) => unknown;
	set?: (provider: string, credential: unknown) => void;
	getApiKey?: (provider: string, options?: { includeFallback?: boolean }) => string | undefined | Promise<string | undefined>;
};

type SessionContextLike = {
	modelRegistry?: {
		authStorage?: AuthStorageLike;
	};
};

async function discoverModels(apiKey: string, inferenceBaseUrl: string) {
	if (!apiKey) return [];
	try {
		return await fetchModelCatalog(apiKey, inferenceBaseUrl, {
			timeoutMs: DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
		});
	} catch (error) {
		if (isModelCatalogAuthError(error)) return [];
		return buildFallbackModels(inferenceBaseUrl);
	}
}

async function startupModels(baseUrl = getInferenceBaseUrl()) {
	const apiKey = process.env.NOUS_API_KEY?.trim();
	if (!apiKey) return [];
	return discoverModels(apiKey, baseUrl);
}

function createProviderConfig(
	baseUrl: string,
	models: NousProviderModelConfig[],
	login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>,
) {
	return {
		name: PROVIDER_NAME,
		baseUrl,
		apiKey: "NOUS_API_KEY",
		api: "openai-completions" as const,
		models,
		oauth: {
			name: PROVIDER_NAME,
			login,
			refreshToken: refreshNousPortalCredentials,
			getApiKey: getNousPortalApiKey,
			modifyModels: applyStoredModelCatalog,
		},
	};
}

function registerNousPortalProvider(
	pi: ExtensionAPI,
	baseUrl: string,
	models: NousProviderModelConfig[],
	login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>,
) {
	pi.registerProvider(PROVIDER_ID, createProviderConfig(baseUrl, models, login));
}

function providerBaseUrlFromCredentials(credentials: { [key: string]: unknown }): string {
	return normalizeBaseUrl(credentials.inferenceBaseUrl, getInferenceBaseUrl());
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
	return typeof value === "object" && value !== null;
}

function isOAuthCredential(value: unknown): value is { [key: string]: unknown; type: "oauth" } {
	return isRecord(value) && value.type === "oauth";
}

function registerCredentialModels(
	pi: ExtensionAPI,
	login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>,
	credentials: { [key: string]: unknown },
) {
	const baseUrl = providerBaseUrlFromCredentials(credentials);
	registerNousPortalProvider(pi, baseUrl, modelsForStoredCredentials(credentials), login);
}

async function apiKeyFromAuthStorage(authStorage: AuthStorageLike): Promise<string | undefined> {
	try {
		const apiKey = await authStorage.getApiKey?.(PROVIDER_ID, { includeFallback: false });
		return typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : undefined;
	} catch {
		return undefined;
	}
}

async function refreshCredentialModelCatalog(
	authStorage: AuthStorageLike,
	credentials: { [key: string]: unknown },
	apiKey: string | undefined,
): Promise<{ [key: string]: unknown }> {
	if (!apiKey) return credentials;

	try {
		const baseUrl = providerBaseUrlFromCredentials(credentials);
		const modelCatalog = await fetchModelCatalog(apiKey, baseUrl, {
			timeoutMs: DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
		});
		const updated = {
			...credentials,
			modelCatalog,
			modelCatalogFetchedAt: Date.now(),
			modelCatalogUnavailable: false,
		};
		authStorage.set?.(PROVIDER_ID, updated);
		return updated;
	} catch {
		const updated = { ...credentials, modelCatalogUnavailable: true };
		authStorage.set?.(PROVIDER_ID, updated);
		return updated;
	}
}

async function registerSessionModels(
	pi: ExtensionAPI,
	login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>,
	context: SessionContextLike,
) {
	const authStorage = context.modelRegistry?.authStorage;
	if (!authStorage) return;

	const apiKey = await apiKeyFromAuthStorage(authStorage);
	const storedCredentials = authStorage.get?.(PROVIDER_ID);
	if (isOAuthCredential(storedCredentials)) {
		const refreshedCredentials = await refreshCredentialModelCatalog(authStorage, storedCredentials, apiKey);
		registerCredentialModels(pi, login, refreshedCredentials);
		return;
	}

	const baseUrl = getInferenceBaseUrl();
	const models = apiKey ? await discoverModels(apiKey, baseUrl) : [];
	registerNousPortalProvider(pi, baseUrl, models, login);
}

export default async function nousPortalProvider(pi: ExtensionAPI) {
	const baseUrl = getInferenceBaseUrl();
	const login = async (callbacks: OAuthLoginCallbacks) => {
		const credentials = await loginNousPortal(callbacks);
		if (isRecord(credentials)) registerCredentialModels(pi, login, credentials);
		return credentials;
	};

	registerNousPortalProvider(pi, baseUrl, await startupModels(baseUrl), login);
	pi.on("session_start", async (_event, context) => {
		await registerSessionModels(pi, login, context as SessionContextLike);
	});
}

export {
	PROVIDER_ID,
	PROVIDER_NAME,
	applyStoredModelCatalog as modifyNousPortalModels,
	fetchModelCatalog,
	loginNousPortal,
	refreshNousPortalCredentials,
};
