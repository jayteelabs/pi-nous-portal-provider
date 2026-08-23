import assert from "node:assert/strict";
import test from "node:test";

import { DIRECT_API_KEY_PROVIDER_ID, PROVIDER_ID, applyStoredModelCatalog } from "../extensions/nous-portal/models.ts";
import {
	DEFAULT_CLIENT_ID,
	KEY_EXPIRY_SKEW_MS,
	TOKEN_EXPIRY_SKEW_MS,
	getClientId,
	getNousPortalApiKey,
	loginNousPortal,
	refreshNousPortalCredentials,
	resolveNousPortalCredentialLifecycle,
	selectNousOAuthCatalogSelection,
} from "../extensions/nous-portal/auth.ts";

function jsonResponse(payload, init = {}) {
	return new Response(JSON.stringify(payload), {
		status: init.status ?? 200,
		headers: { "content-type": "application/json" },
	});
}

function createFetchMock(steps) {
	const calls = [];
	const fetchFn = async (input, init = {}) => {
		calls.push({ url: String(input), init, body: String(init.body ?? "") });
		const step = steps.shift();
		if (!step) throw new Error(`Unexpected fetch call to ${input}`);
		if (typeof step === "function") return step(input, init, calls);
		return jsonResponse(step.body, { status: step.status });
	};
	return { calls, fetchFn };
}

function deviceCodeResponse(overrides = {}) {
	return {
		device_code: "device-code",
		user_code: "USER-CODE",
		verification_uri: "https://portal.example/verify",
		verification_uri_complete: "https://portal.example/verify?user_code=USER-CODE",
		expires_in: 600,
		interval: 1,
		...overrides,
	};
}

test("default OAuth client id uses Hermes client and honors NOUS_CLIENT_ID override", () => {
	const previous = process.env.NOUS_CLIENT_ID;
	try {
		delete process.env.NOUS_CLIENT_ID;
		assert.equal(DEFAULT_CLIENT_ID, "hermes-cli");
		assert.equal(getClientId(), "hermes-cli");

		process.env.NOUS_CLIENT_ID = "pi";
		assert.equal(getClientId(), "pi");
	} finally {
		if (previous === undefined) delete process.env.NOUS_CLIENT_ID;
		else process.env.NOUS_CLIENT_ID = previous;
	}
});

test("device-code login passes Pi device-code callback fields in documented camelCase shape", async () => {
	const { fetchFn } = createFetchMock([
		{
			body: deviceCodeResponse({
				verification_uri: "https://portal.example/manage-subscription",
				verification_uri_complete: "https://portal.example/manage-subscription?user_code=USER-CODE",
			}),
		},
		{
			body: {
				access_token: "portal-access",
				refresh_token: "portal-refresh",
				expires_in: 3600,
			},
		},
		{ body: { data: [] } },
	]);
	const devicePrompts = [];

	await loginNousPortal(
		{
			onAuth: () => {},
			onPrompt: async () => "",
			onDeviceCode: (params) => devicePrompts.push(params),
		},
		{
			fetchFn,
			sleepFn: async () => {},
			portalBaseUrl: "https://portal.example",
		},
	);

	assert.deepEqual(devicePrompts, [
		{
			userCode: "USER-CODE",
			verificationUri: "https://portal.example/manage-subscription?user_code=USER-CODE",
			intervalSeconds: 1,
			expiresInSeconds: 600,
		},
	]);
	assert.doesNotMatch(`${devicePrompts[0].verificationUri}\nEnter code: ${devicePrompts[0].userCode}`, /undefined/);
});

test("device-code login handles pending, slow-down, success, invoke JWT selection, and model cache", async () => {
	const now = Date.parse("2026-01-01T00:00:00.000Z");
	const { calls, fetchFn } = createFetchMock([
		{ body: deviceCodeResponse() },
		{ status: 400, body: { error: "authorization_pending" } },
		{ status: 400, body: { error: "slow_down" } },
		{
			body: {
				access_token: "invoke-jwt",
				refresh_token: "portal-refresh",
				expires_in: 3600,
				token_type: "Bearer",
				scope: "inference:invoke",
				inference_base_url: "https://inference.example/v1",
			},
		},
		{ body: { data: [{ id: "live-model" }] } },
	]);
	const sleeps = [];
	const deviceCodes = [];

	const credentials = await loginNousPortal(
		{
			onAuth: () => {},
			onPrompt: async () => "",
			onDeviceCode: async (device) => deviceCodes.push(device),
		},
		{
			fetchFn,
			sleepFn: async (ms) => sleeps.push(ms),
			now: () => now,
			portalBaseUrl: "https://portal.example",
			inferenceBaseUrl: "https://default-inference.example/v1",
			clientId: "pi",
		},
	);

	assert.deepEqual(sleeps, [1000, 2000]);
	assert.equal(deviceCodes[0].verificationUri, "https://portal.example/verify?user_code=USER-CODE");
	assert.equal(deviceCodes[0].userCode, "USER-CODE");
	assert.equal(credentials.refresh, "portal-refresh");
	assert.equal(credentials.access, "invoke-jwt");
	assert.equal(credentials.expires, now + 3600 * 1000 - KEY_EXPIRY_SKEW_MS);
	assert.equal(credentials.portalAccess, "invoke-jwt");
	assert.equal(credentials.portalAccessExpires, now + 3600 * 1000 - TOKEN_EXPIRY_SKEW_MS);
	assert.equal(credentials.inferenceBaseUrl, "https://inference.example/v1");
	assert.equal(credentials.modelCatalog[0].id, "live-model");
	assert.equal(credentials.modelCatalogFetchedAt, now);
	assert.equal(credentials.modelCatalogUnavailable, false);
	assert.ok(!calls.some((call) => call.url.includes("/api/oauth/agent-key")));
	assert.equal(calls[0].url, "https://portal.example/api/oauth/device/code");
	assert.match(calls[0].body, /client_id=pi/);
	assert.match(calls[0].body, /scope=inference%3Ainvoke/);
	assert.equal(calls[4].url, "https://inference.example/v1/models");
});

test("device-code login marks the model catalog unavailable when discovery fails", async () => {
	const now = Date.parse("2026-01-01T00:00:00.000Z");
	const { fetchFn } = createFetchMock([
		{ body: deviceCodeResponse() },
		{
			body: {
				access_token: "portal-access",
				refresh_token: "portal-refresh",
				expires_in: 3600,
			},
		},
		{ status: 503, body: { error: "unavailable" } },
	]);

	const credentials = await loginNousPortal(
		{ onAuth: () => {}, onPrompt: async () => "", onDeviceCode: () => {} },
		{
			fetchFn,
			sleepFn: async () => {},
			now: () => now,
			portalBaseUrl: "https://portal.example",
		},
	);

	assert.equal(credentials.access, "portal-access");
	assert.equal(credentials.modelCatalog, undefined);
	assert.equal(credentials.modelCatalogFetchedAt, undefined);
	assert.equal(credentials.modelCatalogUnavailable, true);
});

test("device-code login keeps model catalog blank on discovery auth failure", async () => {
	const { fetchFn } = createFetchMock([
		{ body: deviceCodeResponse() },
		{
			body: {
				access_token: "portal-access",
				refresh_token: "portal-refresh",
				expires_in: 3600,
			},
		},
		{ status: 403, body: { error: "revoked" } },
	]);

	const credentials = await loginNousPortal(
		{ onAuth: () => {}, onPrompt: async () => "", onDeviceCode: () => {} },
		{
			fetchFn,
			sleepFn: async () => {},
			portalBaseUrl: "https://portal.example",
		},
	);

	assert.equal(credentials.access, "portal-access");
	assert.deepEqual(credentials.modelCatalog, []);
	assert.equal(credentials.modelCatalogFetchedAt, undefined);
	assert.equal(credentials.modelCatalogUnavailable, false);
	assert.equal(credentials.modelCatalogAuthFailed, true);
	assert.deepEqual(applyStoredModelCatalog([], credentials), []);
});

test("device-code login reports denied authorization", async () => {
	const { fetchFn } = createFetchMock([
		{ body: deviceCodeResponse() },
		{ status: 400, body: { error: "access_denied", error_description: "No" } },
	]);

	await assert.rejects(
		loginNousPortal(
			{ onAuth: () => {}, onPrompt: async () => "", onDeviceCode: () => {} },
			{ fetchFn, sleepFn: async () => {}, portalBaseUrl: "https://portal.example" },
		),
		/denied/,
	);
});

test("device-code login times out while authorization is pending", async () => {
	let now = Date.parse("2026-01-01T00:00:00.000Z");
	const { fetchFn } = createFetchMock([
		{ body: deviceCodeResponse({ expires_in: 2, interval: 1 }) },
		{ status: 400, body: { error: "authorization_pending" } },
		{ status: 400, body: { error: "authorization_pending" } },
	]);

	await assert.rejects(
		loginNousPortal(
			{ onAuth: () => {}, onPrompt: async () => "", onDeviceCode: () => {} },
			{
				fetchFn,
				sleepFn: async (ms) => {
					now += ms;
				},
				now: () => now,
				portalBaseUrl: "https://portal.example",
			},
		),
		/Timed out/,
	);
});

test("device-code request preserves Portal timeout message and parent abort cleanup", async () => {
	const parent = new AbortController();
	let adds = 0;
	let removes = 0;
	const originalAdd = parent.signal.addEventListener.bind(parent.signal);
	const originalRemove = parent.signal.removeEventListener.bind(parent.signal);
	parent.signal.addEventListener = (...args) => {
		adds += 1;
		return originalAdd(...args);
	};
	parent.signal.removeEventListener = (...args) => {
		removes += 1;
		return originalRemove(...args);
	};

	await assert.rejects(
		loginNousPortal(
			{ onAuth: () => {}, onPrompt: async () => "", onDeviceCode: () => {}, signal: parent.signal },
			{
				requestTimeoutMs: 1,
				portalBaseUrl: "https://portal.example",
				fetchFn: async (_input, init) =>
					new Promise((_resolve, reject) => {
						init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
					}),
			},
		),
		/Nous Portal request timed out/,
	);
	assert.equal(adds, 1);
	assert.equal(removes, 1);
});

test("device-code request keeps text Portal error fallback semantics", async () => {
	const { fetchFn } = createFetchMock([
		() => new Response("not json", { status: 502, headers: { "content-type": "text/plain" } }),
	]);

	await assert.rejects(
		loginNousPortal(
			{ onAuth: () => {}, onPrompt: async () => "", onDeviceCode: () => {} },
			{ fetchFn, sleepFn: async () => {}, portalBaseUrl: "https://portal.example" },
		),
		/Device code request failed/,
	);
});

test("lifecycle selection names OAuth catalog availability outcomes", () => {
	const now = Date.parse("2026-01-01T00:00:00.000Z");
	const stored = {
		id: "stored",
		name: "stored",
		baseUrl: "https://old.example/v1",
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};

	assert.deepEqual(selectNousOAuthCatalogSelection({}, { now: () => now }), {
		kind: "blank",
		reason: "missing-agent-key",
		baseUrl: "https://inference-api.nousresearch.com/v1",
	});
	assert.equal(
		selectNousOAuthCatalogSelection({ access: "agent", expires: now - 1 }, { now: () => now }).reason,
		"expired-agent-key",
	);
	assert.equal(
		selectNousOAuthCatalogSelection(
			{ access: "agent", expires: now + 1, modelCatalogAuthFailed: true, modelCatalogUnavailable: true },
			{ now: () => now },
		).reason,
		"auth-failed",
	);
	assert.deepEqual(
		selectNousOAuthCatalogSelection(
			{ access: "agent", expires: now + 1, inferenceBaseUrl: "https://fresh.example/v1", modelCatalog: [stored] },
			{ now: () => now },
		),
		{ kind: "stored", baseUrl: "https://fresh.example/v1", catalog: [stored] },
	);
	assert.equal(
		selectNousOAuthCatalogSelection(
			{ access: "agent", expires: now + 1, modelCatalogUnavailable: true },
			{ now: () => now },
		).kind,
		"fallback",
	);
	assert.equal(
		selectNousOAuthCatalogSelection({ access: "agent", expires: now + 1, modelCatalog: [] }, { now: () => now }).reason,
		"successful-empty-catalog",
	);
	assert.equal(
		selectNousOAuthCatalogSelection({ access: "agent", expires: now + 1 }, { now: () => now }).reason,
		"no-stored-catalog",
	);
});

test("refresh rotates portal refresh tokens, promotes the invoke JWT, stores skewed expiry, and updates models", async () => {
	const now = Date.parse("2026-01-01T00:00:00.000Z");
	const { calls, fetchFn } = createFetchMock([
		{
			body: {
				access_token: "new-invoke-jwt",
				refresh_token: "new-refresh",
				expires_in: 7200,
				scope: "inference:invoke",
				inference_base_url: "https://fresh-inference.example/v1",
			},
		},
		{ body: { data: [{ id: "oauth-live" }] } },
	]);

	const refreshed = await refreshNousPortalCredentials(
		{
			refresh: "old-refresh",
			access: "old-agent-key",
			expires: now - 1,
			portalAccess: "old-portal-access",
			portalAccessExpires: now - 1,
			portalBaseUrl: "https://portal.example",
			inferenceBaseUrl: "https://old-inference.example/v1",
			clientId: "pi",
		},
		{ fetchFn, now: () => now },
	);

	assert.equal(refreshed.refresh, "new-refresh");
	assert.equal(refreshed.portalAccess, "new-invoke-jwt");
	assert.equal(refreshed.access, "new-invoke-jwt");
	assert.equal(refreshed.expires, now + 7200 * 1000 - KEY_EXPIRY_SKEW_MS);
	assert.equal(refreshed.inferenceBaseUrl, "https://fresh-inference.example/v1");
	assert.equal(refreshed.modelCatalog[0].id, "oauth-live");
	assert.equal(refreshed.modelCatalogUnavailable, false);
	assert.match(calls[0].body, /grant_type=refresh_token/);
	assert.match(calls[0].body, /refresh_token=old-refresh/);
	assert.ok(!calls.some((call) => call.url.includes("/api/oauth/agent-key")));
	assert.equal(calls[1].url, "https://fresh-inference.example/v1/models");
});

test("refresh reuses a still-valid agent key", async () => {
	const now = Date.parse("2026-01-01T00:00:00.000Z");
	const { calls, fetchFn } = createFetchMock([]);
	const credentials = {
		refresh: "refresh",
		access: "agent-key",
		expires: now + 3600 * 1000,
		portalAccess: "portal-access",
		portalAccessExpires: now + 3600 * 1000,
		portalBaseUrl: "https://portal.example",
		inferenceBaseUrl: "https://inference.example/v1",
		clientId: "pi",
	};

	const refreshed = await refreshNousPortalCredentials(credentials, { fetchFn, now: () => now });
	assert.equal(refreshed, credentials);
	assert.equal(calls.length, 0);
});

test("lifecycle refreshes the catalog while reusing a still-valid agent key", async () => {
	const now = Date.parse("2026-01-01T00:00:00.000Z");
	const { calls, fetchFn } = createFetchMock([{ body: { data: [{ id: "session-live" }] } }]);
	const credentials = {
		refresh: "refresh",
		access: "agent-key",
		expires: now + 3600 * 1000,
		portalAccess: "portal-access",
		portalAccessExpires: now + 3600 * 1000,
		portalBaseUrl: "https://portal.example",
		inferenceBaseUrl: "https://inference.example/v1",
		clientId: "pi",
		modelCatalog: [
			{
				id: "cached",
				name: "Cached",
				api: "openai-completions",
				baseUrl: "https://old.example/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	};

	const outcome = await resolveNousPortalCredentialLifecycle(credentials, {
		fetchFn,
		now: () => now,
		refreshModelCatalog: true,
	});

	assert.equal(outcome.transition, "usable-agent-key");
	assert.equal(outcome.catalogStatus, "refreshed");
	assert.equal(outcome.credentialChanged, true);
	assert.equal(outcome.apiKey, "agent-key");
	assert.equal(outcome.inferenceBaseUrl, "https://inference.example/v1");
	assert.equal(outcome.credentials.modelCatalog[0].id, "session-live");
	assert.equal(outcome.credentials.modelCatalogFetchedAt, now);
	assert.deepEqual(outcome.registrationCatalog.map((model) => model.id), ["session-live"]);
	assert.equal(calls[0].url, "https://inference.example/v1/models");
});

test("refresh promotes a still-valid portal access token without re-authenticating", async () => {
	const now = Date.parse("2026-01-01T00:00:00.000Z");
	const { calls, fetchFn } = createFetchMock([{ body: { data: [] } }]);

	const refreshed = await refreshNousPortalCredentials(
		{
			refresh: "old-refresh",
			access: "expired-agent-key",
			expires: now - 1,
			portalAccess: "valid-invoke-jwt",
			portalAccessExpires: now + 3600 * 1000,
			portalBaseUrl: "https://portal.example",
			inferenceBaseUrl: "https://inference.example/v1",
			clientId: "pi",
		},
		{ fetchFn, now: () => now },
	);

	assert.equal(refreshed.refresh, "old-refresh");
	assert.equal(refreshed.portalAccess, "valid-invoke-jwt");
	assert.equal(refreshed.access, "valid-invoke-jwt");
	assert.equal(refreshed.expires, refreshed.portalAccessExpires);
	assert.ok(!calls.some((call) => call.url.includes("/api/oauth/")));
	assert.equal(calls[0].url, "https://inference.example/v1/models");
});

test("refresh rotates the portal token when the stored portal access is expired", async () => {
	const now = Date.parse("2026-01-01T00:00:00.000Z");
	const { calls, fetchFn } = createFetchMock([
		{
			body: {
				access_token: "refreshed-access",
				refresh_token: "rotated-refresh",
				expires_in: 3600,
				scope: "inference:invoke",
			},
		},
		{ body: { data: [] } },
	]);

	const refreshed = await refreshNousPortalCredentials(
		{
			refresh: "old-refresh",
			access: "expired-agent-key",
			expires: now - 1,
			portalAccess: "expired-portal-access",
			portalAccessExpires: now - 1,
			portalBaseUrl: "https://portal.example",
			inferenceBaseUrl: "https://inference.example/v1",
			clientId: "pi",
		},
		{ fetchFn, now: () => now },
	);

	assert.equal(refreshed.refresh, "rotated-refresh");
	assert.equal(refreshed.portalAccess, "refreshed-access");
	assert.equal(refreshed.access, "refreshed-access");
	assert.deepEqual(refreshed.modelCatalog, []);
	assert.ok(!calls.some((call) => call.url.includes("/api/oauth/agent-key")));
	assert.match(calls[0].body, /grant_type=refresh_token/);
	assert.match(calls[0].body, /refresh_token=old-refresh/);
	assert.equal(calls[1].url, "https://inference.example/v1/models");
});

test("getApiKey returns the active OAuth access credential", () => {
	assert.equal(getNousPortalApiKey({ refresh: "refresh", access: "agent", expires: 0 }), "agent");
});

test("modifyModels replaces fallback nous-portal catalog and preserves other providers", () => {
	const models = [
		{ provider: "openai", id: "gpt", baseUrl: "https://api.openai.com/v1", api: "openai-completions" },
		{ provider: "nous-portal", id: "fallback", baseUrl: "https://fallback.example/v1", api: "openai-completions" },
		{ provider: DIRECT_API_KEY_PROVIDER_ID, id: "direct", baseUrl: "https://direct.example/v1", api: "openai-completions" },
	];
	const modified = applyStoredModelCatalog(models, {
		access: "agent-key",
		expires: Date.now() + 60_000,
		inferenceBaseUrl: "https://oauth-inference.example/v1",
		modelCatalog: [
			{
				id: "oauth-live",
				name: "OAuth Live",
				api: "openai-completions",
				baseUrl: "https://old.example/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	});

	assert.equal(modified.length, 2);
	assert.equal(modified[0].provider, "openai");
	assert.equal(modified[1].provider, PROVIDER_ID);
	assert.equal(modified[1].id, "oauth-live");
	assert.equal(modified[1].baseUrl, "https://oauth-inference.example/v1");
});

test("modifyModels removes nous-portal models when OAuth credentials are missing or expired", () => {
	const models = [
		{ provider: "openai", id: "gpt", baseUrl: "https://api.openai.com/v1", api: "openai-completions" },
		{ provider: PROVIDER_ID, id: "fallback", baseUrl: "https://fallback.example/v1", api: "openai-completions" },
		{ provider: DIRECT_API_KEY_PROVIDER_ID, id: "direct", baseUrl: "https://direct.example/v1", api: "openai-completions" },
	];

	assert.deepEqual(applyStoredModelCatalog(models, {}), [models[0]]);
	assert.deepEqual(
		applyStoredModelCatalog(models, {
			access: "agent-key",
			expires: Date.now() - 60_000,
			modelCatalogUnavailable: true,
		}),
		[models[0]],
	);
});

test("modifyModels adds fallback catalog only for usable OAuth credentials with unavailable discovery", () => {
	const models = [{ provider: "openai", id: "gpt", baseUrl: "https://api.openai.com/v1", api: "openai-completions" }];
	const modified = applyStoredModelCatalog(models, {
		access: "agent-key",
		expires: Date.now() + 60_000,
		inferenceBaseUrl: "https://oauth-inference.example/v1",
		modelCatalogUnavailable: true,
	});
	const nousModels = modified.filter((model) => model.provider === PROVIDER_ID);

	assert.equal(modified[0].provider, "openai");
	assert.ok(nousModels.length > 5);
	assert.equal(nousModels[0].baseUrl, "https://oauth-inference.example/v1");
});

test("modifyModels keeps nous-portal blank after a successful empty OAuth catalog", () => {
	const models = [
		{ provider: "openai", id: "gpt", baseUrl: "https://api.openai.com/v1", api: "openai-completions" },
		{ provider: PROVIDER_ID, id: "fallback", baseUrl: "https://fallback.example/v1", api: "openai-completions" },
	];
	const modified = applyStoredModelCatalog(models, {
		access: "agent-key",
		expires: Date.now() + 60_000,
		modelCatalog: [],
		modelCatalogUnavailable: false,
	});

	assert.deepEqual(modified, [models[0]]);
});
