import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import {
	PROVIDER_ID,
	PROVIDER_NAME,
	fetchModelCatalog,
	type NousProviderModelConfig,
} from "./models.ts";
import { applyCatalogToProviderModels } from "./model-catalog-policy.ts";
import {
	getNousPortalApiKey,
	loginNousPortal,
	refreshNousPortalCredentials,
} from "./auth.ts";
import {
	resolveNousProviderRuntime,
	resolveOAuthCredentialRegistration,
	resolveSessionRegistration,
	resolveStartupRegistration,
	type AuthStorageLike,
	type NousProviderRuntime,
	type ProviderRegistrationOutcome,
} from "./startup-policy.ts";

type SessionContextLike = {
	modelRegistry?: {
		authStorage?: AuthStorageLike;
	};
};

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

function applyRegistrationOutcome(
	pi: ExtensionAPI,
	login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>,
	outcome: ProviderRegistrationOutcome,
) {
	registerNousPortalProvider(pi, outcome.baseUrl, outcome.models, login);
}

async function registerSessionModels(
	pi: ExtensionAPI,
	login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>,
	context: SessionContextLike,
	runtime: NousProviderRuntime,
) {
	const authStorage = context.modelRegistry?.authStorage;
	const outcome = await resolveSessionRegistration({ authStorage, runtime });
	if (outcome.kind === "skip") return;
	if (outcome.credentialsToStore) authStorage?.set?.(PROVIDER_ID, outcome.credentialsToStore);
	applyRegistrationOutcome(pi, login, outcome);
}

export default async function nousPortalProvider(pi: ExtensionAPI) {
	const runtime = resolveNousProviderRuntime({ env: process.env });
	const login = async (callbacks: OAuthLoginCallbacks) => {
		const credentials = await loginNousPortal(callbacks, {
			portalBaseUrl: runtime.portalBaseUrl,
			inferenceBaseUrl: runtime.inferenceBaseUrl,
			clientId: runtime.clientId,
			minKeyTtlSeconds: runtime.minKeyTtlSeconds,
			fetchFn: runtime.fetchFn,
			now: runtime.now,
			modelFetchTimeoutMs: runtime.modelDiscoveryTimeoutMs,
		});
		if (isRecord(credentials)) applyRegistrationOutcome(pi, login, resolveOAuthCredentialRegistration(credentials, runtime));
		return credentials;
	};

	applyRegistrationOutcome(pi, login, await resolveStartupRegistration(runtime));
	pi.on("session_start", async (_event, context) => {
		await registerSessionModels(pi, login, context as SessionContextLike, runtime);
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
