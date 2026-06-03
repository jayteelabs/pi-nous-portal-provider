import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import {
	DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
	PROVIDER_ID,
	PROVIDER_NAME,
	fetchModelCatalog,
	getInferenceBaseUrl,
	normalizeBaseUrl,
	type NousProviderModelConfig,
} from "./models.ts";
import {
	applyCatalogToProviderModels,
	resolveDirectCatalog,
	transformOAuthCatalogSelection,
} from "./model-catalog-policy.ts";
import {
	getNousPortalApiKey,
	loginNousPortal,
	refreshNousPortalCredentials,
	resolveNousPortalCredentialLifecycle,
	selectNousOAuthCatalogSelection,
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
	return resolveDirectCatalog({
		apiKey,
		baseUrl: inferenceBaseUrl,
		timeoutMs: DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
	});
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
			modifyModels: applyCatalogToProviderModels,
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
	const providerBaseUrl = getInferenceBaseUrl();
	const selection = selectNousOAuthCatalogSelection(credentials, { baseUrl: providerBaseUrl });
	registerNousPortalProvider(pi, normalizeBaseUrl(selection.baseUrl, providerBaseUrl), transformOAuthCatalogSelection(selection), login);
}

async function apiKeyFromAuthStorage(authStorage: AuthStorageLike): Promise<string | undefined> {
	try {
		const apiKey = await authStorage.getApiKey?.(PROVIDER_ID, { includeFallback: false });
		return typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : undefined;
	} catch {
		return undefined;
	}
}

async function refreshCredentialLifecycle(
	authStorage: AuthStorageLike,
	credentials: { [key: string]: unknown },
) {
	const outcome = await resolveNousPortalCredentialLifecycle(credentials as OAuthCredentials, {
		refreshModelCatalog: true,
		modelFetchTimeoutMs: DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
	});
	if (outcome.credentialChanged) authStorage.set?.(PROVIDER_ID, outcome.credentials);
	return outcome;
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
		if (!apiKey) {
			registerCredentialModels(pi, login, storedCredentials);
			return;
		}
		const outcome = await refreshCredentialLifecycle(authStorage, storedCredentials);
		registerNousPortalProvider(pi, outcome.inferenceBaseUrl, outcome.registrationCatalog, login);
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
	applyCatalogToProviderModels as modifyNousPortalModels,
	fetchModelCatalog,
	loginNousPortal,
	refreshNousPortalCredentials,
};
