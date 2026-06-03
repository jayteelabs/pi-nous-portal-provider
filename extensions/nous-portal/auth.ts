import type { OAuthCredentials, OAuthLoginCallbacks } from "@mariozechner/pi-ai";
import {
	DEFAULT_INFERENCE_BASE_URL,
	coerceStoredCatalog,
	type NousProviderModelConfig,
	normalizeBaseUrl,
} from "./models.ts";
import {
	refreshOAuthCatalog,
	transformOAuthCatalogSelection,
	type NousOAuthCatalogSelection,
} from "./model-catalog-policy.ts";

export const DEFAULT_PORTAL_BASE_URL = "https://portal.nousresearch.com";
export const DEFAULT_CLIENT_ID = "hermes-cli";
export const DEFAULT_SCOPE = "inference:mint_agent_key";
export const DEFAULT_MIN_KEY_TTL_SECONDS = 1800;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
export const TOKEN_EXPIRY_SKEW_MS = 5 * 60 * 1000;
export const KEY_EXPIRY_SKEW_MS = 5 * 60 * 1000;
export const DEVICE_POLL_INTERVAL_CAP_SECONDS = 30;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export type NousOAuthOptions = {
	fetchFn?: FetchLike;
	sleepFn?: SleepFn;
	now?: () => number;
	portalBaseUrl?: string;
	inferenceBaseUrl?: string;
	clientId?: string;
	scope?: string;
	minKeyTtlSeconds?: number;
	requestTimeoutMs?: number;
	modelFetchTimeoutMs?: number;
	forcePortalRefresh?: boolean;
	forceMint?: boolean;
	refreshModelCatalog?: boolean;
};

type RuntimeConfig = {
	fetchFn: FetchLike;
	sleepFn: SleepFn;
	now: () => number;
	portalBaseUrl: string;
	inferenceBaseUrl: string;
	clientId: string;
	scope: string;
	minKeyTtlSeconds: number;
	requestTimeoutMs: number;
	modelFetchTimeoutMs: number;
	forcePortalRefresh: boolean;
	forceMint: boolean;
	refreshModelCatalog: boolean;
};

type DeviceCodeResponse = {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
};

type TokenResponse = {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	token_type?: string;
	scope?: string;
	inference_base_url?: string;
};

type AgentKeyResponse = {
	api_key: string;
	key_id?: string;
	expires_at?: string;
	expires_in?: number;
	reused?: boolean;
	inference_base_url?: string;
};

type ModelCatalogRefreshResult = {
	catalog?: NousProviderModelConfig[];
	unavailable: boolean;
	authFailed?: boolean;
	fetchedAt?: number;
};

export type NousOAuthLifecycleTransition =
	| "usable-agent-key"
	| "portal-token-refreshed"
	| "agent-key-minted"
	| "invalid-portal-token-retried";

export type NousOAuthCatalogStatus = "refreshed" | "unavailable" | "auth-failed-blank" | "unchanged";

export type NousOAuthLifecycleOutcome = {
	credentials: NousOAuthCredentials;
	credentialChanged: boolean;
	apiKey: string;
	inferenceBaseUrl: string;
	transition: NousOAuthLifecycleTransition;
	catalogStatus: NousOAuthCatalogStatus;
	catalogSelection: NousOAuthCatalogSelection;
	registrationCatalog: NousProviderModelConfig[];
};

export type NousOAuthCredentials = OAuthCredentials & {
	portalAccess?: string;
	portalAccessExpires?: number;
	tokenType?: string;
	scope?: string;
	portalBaseUrl?: string;
	inferenceBaseUrl?: string;
	clientId?: string;
	agentKeyId?: string;
	agentKeyExpiresAt?: string;
	agentKeyExpiresIn?: number;
	agentKeyReused?: boolean;
	agentKeyObtainedAt?: number;
	modelCatalog?: NousProviderModelConfig[];
	modelCatalogFetchedAt?: number;
	modelCatalogUnavailable?: boolean;
	modelCatalogAuthFailed?: boolean;
};

class PortalHttpError extends Error {
	readonly status: number;
	readonly code?: string;

	constructor(message: string, status: number, code?: string) {
		super(message);
		this.name = "PortalHttpError";
		this.status = status;
		this.code = code;
	}
}

export function getPortalBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	return normalizeBaseUrl(env.NOUS_PORTAL_BASE_URL, DEFAULT_PORTAL_BASE_URL);
}

export function getClientId(env: NodeJS.ProcessEnv = process.env): string {
	return env.NOUS_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID;
}

export function getMinKeyTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number(env.NOUS_MIN_KEY_TTL_SECONDS);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MIN_KEY_TTL_SECONDS;
}

function resolveOptions(options: NousOAuthOptions = {}): RuntimeConfig {
	return {
		fetchFn: options.fetchFn ?? fetch,
		sleepFn: options.sleepFn ?? sleep,
		now: options.now ?? Date.now,
		portalBaseUrl: normalizeBaseUrl(options.portalBaseUrl ?? process.env.NOUS_PORTAL_BASE_URL, DEFAULT_PORTAL_BASE_URL),
		inferenceBaseUrl: normalizeBaseUrl(
			options.inferenceBaseUrl ?? process.env.NOUS_INFERENCE_BASE_URL,
			DEFAULT_INFERENCE_BASE_URL,
		),
		clientId: options.clientId?.trim() || getClientId(),
		scope: options.scope?.trim() || DEFAULT_SCOPE,
		minKeyTtlSeconds: Math.max(60, Math.floor(options.minKeyTtlSeconds ?? getMinKeyTtlSeconds())),
		requestTimeoutMs: Math.max(1, Math.floor(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)),
		modelFetchTimeoutMs: Math.max(1, Math.floor(options.modelFetchTimeoutMs ?? 3000)),
		forcePortalRefresh: Boolean(options.forcePortalRefresh),
		forceMint: Boolean(options.forceMint),
		refreshModelCatalog: Boolean(options.refreshModelCatalog),
	};
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}
		const cleanup = () => signal?.removeEventListener("abort", abort);
		const timeout = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const abort = () => {
			clearTimeout(timeout);
			cleanup();
			reject(abortError(signal));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function abortError(signal?: AbortSignal): Error {
	return signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted");
}

function assertNotAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError(signal);
}

function timeoutSignal(timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const abortFromParent = () => controller.abort(parent?.reason);
	if (parent?.aborted) controller.abort(parent.reason);
	else parent?.addEventListener("abort", abortFromParent, { once: true });
	timeout = setTimeout(() => controller.abort(new Error("Nous Portal request timed out")), timeoutMs);
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			parent?.removeEventListener("abort", abortFromParent);
		},
	};
}

async function parseJsonResponse(response: Response): Promise<unknown> {
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) return response.json();
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

async function request(
	config: RuntimeConfig,
	url: string,
	init: RequestInit,
	parentSignal?: AbortSignal,
): Promise<Response> {
	const { signal, cleanup } = timeoutSignal(config.requestTimeoutMs, parentSignal);
	try {
		return await config.fetchFn(url, { ...init, signal });
	} finally {
		cleanup();
	}
}

async function postForm(
	config: RuntimeConfig,
	path: string,
	body: Record<string, string>,
	parentSignal?: AbortSignal,
): Promise<Response> {
	return request(
		config,
		`${config.portalBaseUrl}${path}`,
		{
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(body).toString(),
		},
		parentSignal,
	);
}

async function requestDeviceCode(config: RuntimeConfig, signal?: AbortSignal): Promise<DeviceCodeResponse> {
	const response = await postForm(
		config,
		"/api/oauth/device/code",
		{ client_id: config.clientId, scope: config.scope },
		signal,
	);
	if (!response.ok) throw await responseError(response, "Device code request failed");
	const data = asRecord(await parseJsonResponse(response));
	const required = ["device_code", "user_code", "verification_uri", "verification_uri_complete"];
	const missing = required.filter((key) => !asString(data[key]));
	if (missing.length > 0) throw new Error(`Device code response missing fields: ${missing.join(", ")}`);
	const expiresIn = asNumber(data.expires_in);
	const interval = asNumber(data.interval);
	if (!expiresIn || !interval) throw new Error("Device code response missing expires_in or interval");
	return {
		device_code: asString(data.device_code)!,
		user_code: asString(data.user_code)!,
		verification_uri: asString(data.verification_uri)!,
		verification_uri_complete: asString(data.verification_uri_complete)!,
		expires_in: expiresIn,
		interval,
	};
}

async function responseError(response: Response, fallback: string): Promise<PortalHttpError> {
	const payload = asRecord(await parseJsonResponse(response).catch(() => ({})));
	const code = asString(payload.error);
	const description = asString(payload.error_description) ?? asString(payload.message);
	return new PortalHttpError(`${code ? `${code}: ` : ""}${description ?? fallback}`, response.status, code);
}

async function pollForToken(
	config: RuntimeConfig,
	device: DeviceCodeResponse,
	signal?: AbortSignal,
): Promise<TokenResponse> {
	const deadline = config.now() + Math.max(1, device.expires_in) * 1000;
	let intervalSeconds = Math.max(1, Math.min(device.interval, DEVICE_POLL_INTERVAL_CAP_SECONDS));

	while (config.now() < deadline) {
		assertNotAborted(signal);
		const response = await postForm(
			config,
			"/api/oauth/token",
			{
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: config.clientId,
				device_code: device.device_code,
			},
			signal,
		);

		if (response.ok) return validateTokenResponse(await parseJsonResponse(response));

		const error = await responseError(response, "Token polling failed");
		if (error.code === "authorization_pending") {
			await config.sleepFn(intervalSeconds * 1000, signal);
			continue;
		}
		if (error.code === "slow_down") {
			intervalSeconds = Math.min(intervalSeconds + 1, DEVICE_POLL_INTERVAL_CAP_SECONDS);
			await config.sleepFn(intervalSeconds * 1000, signal);
			continue;
		}
		if (error.code === "access_denied" || error.code === "authorization_denied") {
			throw new Error("Nous Portal login was denied.");
		}
		if (error.code === "expired_token") {
			throw new Error("Nous Portal device authorization expired.");
		}
		throw error;
	}

	throw new Error("Timed out waiting for Nous Portal device authorization.");
}

function validateTokenResponse(payload: unknown): TokenResponse {
	const data = asRecord(payload);
	const accessToken = asString(data.access_token);
	if (!accessToken) throw new Error("Token response missing access_token");
	return {
		access_token: accessToken,
		refresh_token: asString(data.refresh_token),
		expires_in: asNumber(data.expires_in),
		token_type: asString(data.token_type),
		scope: asString(data.scope),
		inference_base_url: asString(data.inference_base_url),
	};
}

async function refreshPortalToken(
	config: RuntimeConfig,
	refreshToken: string,
	signal?: AbortSignal,
): Promise<TokenResponse> {
	const response = await postForm(
		config,
		"/api/oauth/token",
		{ grant_type: "refresh_token", client_id: config.clientId, refresh_token: refreshToken },
		signal,
	);
	if (!response.ok) throw await responseError(response, "Refresh token exchange failed");
	return validateTokenResponse(await parseJsonResponse(response));
}

async function mintAgentKey(
	config: RuntimeConfig,
	portalAccessToken: string,
	signal?: AbortSignal,
): Promise<AgentKeyResponse> {
	const response = await request(
		config,
		`${config.portalBaseUrl}/api/oauth/agent-key`,
		{
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${portalAccessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ min_ttl_seconds: config.minKeyTtlSeconds }),
		},
		signal,
	);
	if (!response.ok) throw await responseError(response, "Agent key mint request failed");
	const data = asRecord(await parseJsonResponse(response));
	const apiKey = asString(data.api_key);
	if (!apiKey) throw new Error("Agent key mint response missing api_key");
	return {
		api_key: apiKey,
		key_id: asString(data.key_id),
		expires_at: asString(data.expires_at),
		expires_in: asNumber(data.expires_in),
		reused: Boolean(data.reused),
		inference_base_url: asString(data.inference_base_url),
	};
}

function tokenExpiresAt(token: TokenResponse, config: RuntimeConfig): number {
	return config.now() + Math.max(60, Math.floor(token.expires_in ?? 3600)) * 1000 - TOKEN_EXPIRY_SKEW_MS;
}

function agentKeyExpiresAt(mint: AgentKeyResponse, config: RuntimeConfig): number {
	if (mint.expires_at) {
		const parsed = Date.parse(mint.expires_at);
		if (Number.isFinite(parsed)) return parsed - KEY_EXPIRY_SKEW_MS;
	}
	return config.now() + Math.max(60, Math.floor(mint.expires_in ?? config.minKeyTtlSeconds)) * 1000 - KEY_EXPIRY_SKEW_MS;
}

async function refreshModelCatalog(
	apiKey: string,
	inferenceBaseUrl: string,
	config: RuntimeConfig,
	signal?: AbortSignal,
): Promise<ModelCatalogRefreshResult> {
	return refreshOAuthCatalog({
		apiKey,
		baseUrl: inferenceBaseUrl,
		fetchFn: config.fetchFn,
		timeoutMs: config.modelFetchTimeoutMs,
		signal,
		now: config.now,
	});
}

function createCredentials(
	config: RuntimeConfig,
	token: TokenResponse,
	mint: AgentKeyResponse,
	modelCatalogRefresh: ModelCatalogRefreshResult,
): NousOAuthCredentials {
	const inferenceBaseUrl = normalizeBaseUrl(mint.inference_base_url ?? token.inference_base_url, config.inferenceBaseUrl);
	return {
		refresh: token.refresh_token ?? "",
		access: mint.api_key,
		expires: agentKeyExpiresAt(mint, config),
		portalAccess: token.access_token,
		portalAccessExpires: tokenExpiresAt(token, config),
		tokenType: token.token_type ?? "Bearer",
		scope: token.scope ?? config.scope,
		portalBaseUrl: config.portalBaseUrl,
		inferenceBaseUrl,
		clientId: config.clientId,
		agentKeyId: mint.key_id,
		agentKeyExpiresAt: mint.expires_at,
		agentKeyExpiresIn: mint.expires_in,
		agentKeyReused: mint.reused,
		agentKeyObtainedAt: config.now(),
		modelCatalog: modelCatalogRefresh.authFailed ? [] : modelCatalogRefresh.catalog,
		modelCatalogFetchedAt:
			modelCatalogRefresh.unavailable || modelCatalogRefresh.authFailed
				? undefined
				: (modelCatalogRefresh.fetchedAt ?? config.now()),
		modelCatalogUnavailable: modelCatalogRefresh.unavailable,
		modelCatalogAuthFailed: modelCatalogRefresh.authFailed === true,
	};
}

function mergeCatalogIntoCredentials(
	credentials: NousOAuthCredentials,
	config: RuntimeConfig,
	modelCatalogRefresh: ModelCatalogRefreshResult,
): NousOAuthCredentials {
	return {
		...credentials,
		modelCatalog: modelCatalogRefresh.authFailed
			? []
			: modelCatalogRefresh.unavailable
				? credentials.modelCatalog
				: modelCatalogRefresh.catalog,
		modelCatalogFetchedAt:
			modelCatalogRefresh.authFailed || modelCatalogRefresh.unavailable
				? credentials.modelCatalogFetchedAt
				: (modelCatalogRefresh.fetchedAt ?? config.now()),
		modelCatalogUnavailable: modelCatalogRefresh.authFailed ? false : modelCatalogRefresh.unavailable,
		modelCatalogAuthFailed: modelCatalogRefresh.authFailed === true,
	};
}

function credentialExpiry(value: unknown): number {
	if (typeof value === "number") return value;
	if (typeof value === "string" && value.trim()) return Number(value);
	return NaN;
}

export function selectNousOAuthCatalogSelection(
	credentials: Partial<NousOAuthCredentials> | Record<string, unknown> = {},
	options: { now?: () => number; baseUrl?: string } = {},
): NousOAuthCatalogSelection {
	const baseUrl = normalizeBaseUrl(credentials.inferenceBaseUrl ?? options.baseUrl, DEFAULT_INFERENCE_BASE_URL);
	const access = typeof credentials.access === "string" && credentials.access.trim().length > 0;
	if (!access) return { kind: "blank", reason: "missing-agent-key", baseUrl };

	const expires = credentialExpiry(credentials.expires);
	if (!Number.isFinite(expires) || expires <= (options.now ?? Date.now)()) {
		return { kind: "blank", reason: "expired-agent-key", baseUrl };
	}

	if (credentials.modelCatalogAuthFailed === true) return { kind: "blank", reason: "auth-failed", baseUrl };

	const storedCatalog = coerceStoredCatalog(credentials.modelCatalog);
	if (storedCatalog.length > 0) return { kind: "stored", baseUrl, catalog: storedCatalog };

	if (credentials.modelCatalogUnavailable === true) return { kind: "fallback", reason: "catalog-unavailable", baseUrl };

	if (Array.isArray(credentials.modelCatalog)) return { kind: "blank", reason: "successful-empty-catalog", baseUrl };
	return { kind: "blank", reason: "no-stored-catalog", baseUrl };
}

function catalogStatus(refresh?: ModelCatalogRefreshResult): NousOAuthCatalogStatus {
	if (!refresh) return "unchanged";
	if (refresh.authFailed) return "auth-failed-blank";
	if (refresh.unavailable) return "unavailable";
	return "refreshed";
}

function lifecycleOutcome(
	credentials: NousOAuthCredentials,
	config: RuntimeConfig,
	transition: NousOAuthLifecycleTransition,
	catalog: ModelCatalogRefreshResult | undefined,
	credentialChanged: boolean,
): NousOAuthLifecycleOutcome {
	const inferenceBaseUrl = normalizeBaseUrl(credentials.inferenceBaseUrl, config.inferenceBaseUrl);
	const catalogSelection = selectNousOAuthCatalogSelection(credentials, { now: config.now, baseUrl: inferenceBaseUrl });
	return {
		credentials,
		credentialChanged,
		apiKey: credentials.access,
		inferenceBaseUrl,
		transition,
		catalogStatus: catalogStatus(catalog),
		catalogSelection,
		registrationCatalog: transformOAuthCatalogSelection(catalogSelection),
	};
}

type DeviceCodeCallback = OAuthLoginCallbacks & {
	onDeviceCode?: (device: DeviceCodeResponse) => void | Promise<void>;
};

export async function loginNousPortal(
	callbacks: OAuthLoginCallbacks,
	options: NousOAuthOptions = {},
): Promise<OAuthCredentials> {
	const config = resolveOptions(options);
	const device = await requestDeviceCode(config, callbacks.signal);
	callbacks.onAuth({
		url: device.verification_uri_complete,
		instructions: `Open the URL and confirm code ${device.user_code}.`,
	});
	await (callbacks as DeviceCodeCallback).onDeviceCode?.(device);
	const token = await pollForToken(config, device, callbacks.signal);
	if (!token.refresh_token) throw new Error("Token response missing refresh_token");
	const mint = await mintAgentKey(config, token.access_token, callbacks.signal);
	const inferenceBaseUrl = normalizeBaseUrl(mint.inference_base_url ?? token.inference_base_url, config.inferenceBaseUrl);
	const catalog = await refreshModelCatalog(mint.api_key, inferenceBaseUrl, config, callbacks.signal);
	return createCredentials(config, token, mint, catalog);
}

function credentialString(credentials: OAuthCredentials, key: keyof NousOAuthCredentials): string | undefined {
	return asString((credentials as NousOAuthCredentials)[key]);
}

function credentialNumber(credentials: OAuthCredentials, key: keyof NousOAuthCredentials): number | undefined {
	return asNumber((credentials as NousOAuthCredentials)[key]);
}

function isAgentKeyUsable(credentials: OAuthCredentials, config: RuntimeConfig): boolean {
	return Boolean(credentials.access?.trim()) && config.now() < credentials.expires;
}

function needsPortalRefresh(credentials: OAuthCredentials, config: RuntimeConfig): boolean {
	const portalAccess = credentialString(credentials, "portalAccess");
	const portalExpires = credentialNumber(credentials, "portalAccessExpires") ?? 0;
	return config.forcePortalRefresh || !portalAccess || config.now() >= portalExpires;
}

function mergeTokenIntoCredentials(
	credentials: OAuthCredentials,
	config: RuntimeConfig,
	token: TokenResponse,
): NousOAuthCredentials {
	const current = credentials as NousOAuthCredentials;
	return {
		...current,
		refresh: token.refresh_token ?? credentials.refresh,
		portalAccess: token.access_token,
		portalAccessExpires: tokenExpiresAt(token, config),
		tokenType: token.token_type ?? current.tokenType ?? "Bearer",
		scope: token.scope ?? current.scope ?? config.scope,
		inferenceBaseUrl: normalizeBaseUrl(token.inference_base_url ?? current.inferenceBaseUrl, config.inferenceBaseUrl),
		portalBaseUrl: current.portalBaseUrl ?? config.portalBaseUrl,
		clientId: current.clientId ?? config.clientId,
	};
}

function mergeMintIntoCredentials(
	credentials: NousOAuthCredentials,
	config: RuntimeConfig,
	mint: AgentKeyResponse,
	modelCatalogRefresh: ModelCatalogRefreshResult,
): NousOAuthCredentials {
	return mergeCatalogIntoCredentials(
		{
			...credentials,
			access: mint.api_key,
			expires: agentKeyExpiresAt(mint, config),
			inferenceBaseUrl: normalizeBaseUrl(mint.inference_base_url ?? credentials.inferenceBaseUrl, config.inferenceBaseUrl),
			agentKeyId: mint.key_id,
			agentKeyExpiresAt: mint.expires_at,
			agentKeyExpiresIn: mint.expires_in,
			agentKeyReused: mint.reused,
			agentKeyObtainedAt: config.now(),
		},
		config,
		modelCatalogRefresh,
	);
}

export async function resolveNousPortalCredentialLifecycle(
	credentials: OAuthCredentials,
	options: NousOAuthOptions = {},
): Promise<NousOAuthLifecycleOutcome> {
	let config = resolveOptions({
		...options,
		portalBaseUrl: options.portalBaseUrl ?? credentialString(credentials, "portalBaseUrl"),
		inferenceBaseUrl: options.inferenceBaseUrl ?? credentialString(credentials, "inferenceBaseUrl"),
		clientId: options.clientId ?? credentialString(credentials, "clientId"),
		scope: options.scope ?? credentialString(credentials, "scope"),
	});

	let updated = credentials as NousOAuthCredentials;
	let didRefreshPortal = false;
	let transition: NousOAuthLifecycleTransition = "usable-agent-key";
	let credentialChanged = false;
	if (config.refreshModelCatalog && !config.forceMint && !config.forcePortalRefresh && isAgentKeyUsable(updated, config)) {
		const catalog = await refreshModelCatalog(
			updated.access,
			normalizeBaseUrl(updated.inferenceBaseUrl, config.inferenceBaseUrl),
			config,
		);
		updated = mergeCatalogIntoCredentials(updated, config, catalog);
		return lifecycleOutcome(updated, config, transition, catalog, true);
	}

	if (needsPortalRefresh(updated, config)) {
		const refreshed = await refreshPortalToken(config, updated.refresh);
		updated = mergeTokenIntoCredentials(updated, config, refreshed);
		didRefreshPortal = true;
		credentialChanged = true;
		transition = "portal-token-refreshed";
		config = resolveOptions({
			...options,
			portalBaseUrl: updated.portalBaseUrl,
			inferenceBaseUrl: updated.inferenceBaseUrl,
			clientId: updated.clientId,
			scope: updated.scope,
		});
	}

	if (!config.forceMint && isAgentKeyUsable(updated, config)) {
		let catalog: ModelCatalogRefreshResult | undefined;
		if (config.refreshModelCatalog) {
			catalog = await refreshModelCatalog(updated.access, normalizeBaseUrl(updated.inferenceBaseUrl, config.inferenceBaseUrl), config);
			updated = mergeCatalogIntoCredentials(updated, config, catalog);
			credentialChanged = true;
		}
		return lifecycleOutcome(updated, config, transition, catalog, credentialChanged);
	}

	let mint: AgentKeyResponse;
	try {
		mint = await mintAgentKey(config, updated.portalAccess ?? "", undefined);
	} catch (error) {
		const code = error instanceof PortalHttpError ? error.code : undefined;
		if ((code === "invalid_token" || code === "invalid_grant") && !didRefreshPortal) {
			const refreshed = await refreshPortalToken(config, updated.refresh);
			updated = mergeTokenIntoCredentials(updated, config, refreshed);
			credentialChanged = true;
			transition = "invalid-portal-token-retried";
			config = resolveOptions({
				...options,
				portalBaseUrl: updated.portalBaseUrl,
				inferenceBaseUrl: updated.inferenceBaseUrl,
				clientId: updated.clientId,
				scope: updated.scope,
			});
			mint = await mintAgentKey(config, updated.portalAccess ?? "", undefined);
		} else {
			throw error;
		}
	}
	if (transition !== "invalid-portal-token-retried") transition = "agent-key-minted";

	const inferenceBaseUrl = normalizeBaseUrl(mint.inference_base_url ?? updated.inferenceBaseUrl, config.inferenceBaseUrl);
	const catalog = await refreshModelCatalog(mint.api_key, inferenceBaseUrl, config);
	updated = mergeMintIntoCredentials(updated, config, mint, catalog);
	return lifecycleOutcome(updated, config, transition, catalog, true);
}

export async function refreshNousPortalCredentials(
	credentials: OAuthCredentials,
	options: NousOAuthOptions = {},
): Promise<OAuthCredentials> {
	return (await resolveNousPortalCredentialLifecycle(credentials, options)).credentials;
}

export function getNousPortalApiKey(credentials: OAuthCredentials): string {
	return credentials.access;
}
