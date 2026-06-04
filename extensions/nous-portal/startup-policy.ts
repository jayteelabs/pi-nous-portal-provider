import type { OAuthCredentials } from "@mariozechner/pi-ai";
import {
	DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
	PROVIDER_ID,
	getInferenceBaseUrl,
	normalizeBaseUrl,
	type NousProviderModelConfig,
} from "./models.ts";
import { resolveDirectCatalog, transformOAuthCatalogSelection } from "./model-catalog-policy.ts";
import {
	getClientId,
	getMinKeyTtlSeconds,
	getPortalBaseUrl,
	resolveNousPortalCredentialLifecycle,
	selectNousOAuthCatalogSelection,
} from "./auth.ts";
import type { FetchLike } from "./provider-requests.ts";

export type EnvLike = Record<string, string | undefined>;

export type AuthStorageLike = {
	get?: (provider: string) => unknown;
	set?: (provider: string, credential: unknown) => void;
	getApiKey?: (provider: string, options?: { includeFallback?: boolean }) => string | undefined | Promise<string | undefined>;
};

export type NousProviderRuntimeInputs = {
	env?: EnvLike;
	fetchFn?: FetchLike;
	now?: () => number;
	modelDiscoveryTimeoutMs?: number;
};

export type NousProviderRuntime = {
	directApiKey?: string;
	inferenceBaseUrl: string;
	portalBaseUrl: string;
	clientId: string;
	minKeyTtlSeconds: number;
	fetchFn?: FetchLike;
	now?: () => number;
	modelDiscoveryTimeoutMs: number;
};

export type ProviderRegistrationReason =
	| "startup-no-direct-key"
	| "startup-direct-key"
	| "oauth-login-credentials"
	| "session-no-credentials"
	| "session-stored-oauth"
	| "session-oauth-lifecycle"
	| "session-direct-key";

export type ProviderRegistrationOutcome = {
	kind: "register";
	reason: ProviderRegistrationReason;
	baseUrl: string;
	models: NousProviderModelConfig[];
	credentialsToStore?: OAuthCredentials;
};

export type SessionPolicyOutcome = ProviderRegistrationOutcome | { kind: "skip"; reason: "missing-auth-storage" };

function isRecord(value: unknown): value is { [key: string]: unknown } {
	return typeof value === "object" && value !== null;
}

function isOAuthCredential(value: unknown): value is { [key: string]: unknown; type: "oauth" } {
	return isRecord(value) && value.type === "oauth";
}

async function apiKeyFromAuthStorage(authStorage: AuthStorageLike): Promise<string | undefined> {
	try {
		const apiKey = await authStorage.getApiKey?.(PROVIDER_ID, { includeFallback: false });
		return typeof apiKey === "string" && apiKey.trim() ? apiKey.trim() : undefined;
	} catch {
		return undefined;
	}
}

export function resolveNousProviderRuntime(inputs: NousProviderRuntimeInputs = {}): NousProviderRuntime {
	const env = inputs.env ?? process.env;
	return {
		directApiKey: env.NOUS_API_KEY?.trim() || undefined,
		inferenceBaseUrl: getInferenceBaseUrl(env as NodeJS.ProcessEnv),
		portalBaseUrl: getPortalBaseUrl(env as NodeJS.ProcessEnv),
		clientId: getClientId(env as NodeJS.ProcessEnv),
		minKeyTtlSeconds: getMinKeyTtlSeconds(env as NodeJS.ProcessEnv),
		fetchFn: inputs.fetchFn,
		now: inputs.now,
		modelDiscoveryTimeoutMs: inputs.modelDiscoveryTimeoutMs ?? DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
	};
}

export async function resolveStartupRegistration(runtime: NousProviderRuntime): Promise<ProviderRegistrationOutcome> {
	if (!runtime.directApiKey) {
		return { kind: "register", reason: "startup-no-direct-key", baseUrl: runtime.inferenceBaseUrl, models: [] };
	}

	return {
		kind: "register",
		reason: "startup-direct-key",
		baseUrl: runtime.inferenceBaseUrl,
		models: await resolveDirectCatalog({
			apiKey: runtime.directApiKey,
			baseUrl: runtime.inferenceBaseUrl,
			fetchFn: runtime.fetchFn,
			timeoutMs: runtime.modelDiscoveryTimeoutMs,
		}),
	};
}

export function resolveOAuthCredentialRegistration(
	credentials: Record<string, unknown>,
	runtime: NousProviderRuntime,
): ProviderRegistrationOutcome {
	const selection = selectNousOAuthCatalogSelection(credentials, {
		baseUrl: runtime.inferenceBaseUrl,
		now: runtime.now,
	});
	return {
		kind: "register",
		reason: "oauth-login-credentials",
		baseUrl: normalizeBaseUrl(selection.baseUrl, runtime.inferenceBaseUrl),
		models: transformOAuthCatalogSelection(selection),
	};
}

export async function resolveSessionRegistration(input: {
	authStorage?: AuthStorageLike;
	runtime: NousProviderRuntime;
}): Promise<SessionPolicyOutcome> {
	const { authStorage, runtime } = input;
	if (!authStorage) return { kind: "skip", reason: "missing-auth-storage" };

	const apiKey = await apiKeyFromAuthStorage(authStorage);
	const storedCredentials = authStorage.get?.(PROVIDER_ID);
	if (isOAuthCredential(storedCredentials)) {
		if (!apiKey) {
			return { ...resolveOAuthCredentialRegistration(storedCredentials, runtime), reason: "session-stored-oauth" };
		}

		const outcome = await resolveNousPortalCredentialLifecycle(storedCredentials as OAuthCredentials, {
			refreshModelCatalog: true,
			fetchFn: runtime.fetchFn,
			now: runtime.now,
			minKeyTtlSeconds: runtime.minKeyTtlSeconds,
			modelFetchTimeoutMs: runtime.modelDiscoveryTimeoutMs,
		});

		return {
			kind: "register",
			reason: "session-oauth-lifecycle",
			baseUrl: outcome.inferenceBaseUrl,
			models: outcome.registrationCatalog,
			credentialsToStore: outcome.credentialChanged ? outcome.credentials : undefined,
		};
	}

	return {
		kind: "register",
		reason: apiKey ? "session-direct-key" : "session-no-credentials",
		baseUrl: runtime.inferenceBaseUrl,
		models: apiKey
			? await resolveDirectCatalog({
					apiKey,
					baseUrl: runtime.inferenceBaseUrl,
					fetchFn: runtime.fetchFn,
					timeoutMs: runtime.modelDiscoveryTimeoutMs,
				})
			: [],
	};
}
