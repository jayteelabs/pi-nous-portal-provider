import assert from "node:assert/strict";
import test from "node:test";

import { PROVIDER_ID } from "../extensions/nous-portal/index.ts";
import {
	resolveNousProviderRuntime,
	resolveOAuthCredentialRegistration,
	resolveSessionRegistration,
	resolveStartupRegistration,
} from "../extensions/nous-portal/startup-policy.ts";

function jsonResponse(payload, init = {}) {
	return new Response(JSON.stringify(payload), {
		status: init.status ?? 200,
		headers: { "content-type": "application/json" },
	});
}

function storedModel(id, baseUrl = "https://inference.example/v1") {
	return {
		id,
		name: id,
		api: "openai-completions",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

test("runtime normalizes injected env and blank direct API keys", () => {
	const runtime = resolveNousProviderRuntime({
		env: {
			NOUS_API_KEY: "  ",
			NOUS_INFERENCE_BASE_URL: "https://inference.example/v1/",
			NOUS_PORTAL_BASE_URL: "https://portal.example/",
			NOUS_CLIENT_ID: " custom-client ",
			NOUS_MIN_KEY_TTL_SECONDS: "90",
		},
	});
	assert.equal(runtime.directApiKey, undefined);
	assert.equal(runtime.inferenceBaseUrl, "https://inference.example/v1");
	assert.equal(runtime.portalBaseUrl, "https://portal.example");
	assert.equal(runtime.clientId, "custom-client");
	assert.equal(runtime.minKeyTtlSeconds, 90);
});

test("startup without a direct API key registers fallback models for Pi API-key login discovery", async () => {
	const outcome = await resolveStartupRegistration(resolveNousProviderRuntime({ env: {} }));
	assert.equal(outcome.reason, "startup-no-direct-key");
	assert.equal(outcome.baseUrl, "https://inference-api.nousresearch.com/v1");
	assert.ok(outcome.models.length > 5);
	assert.equal(outcome.models[0].baseUrl, "https://inference-api.nousresearch.com/v1");
});

test("startup direct API key uses injected fetch for live catalog", async () => {
	const calls = [];
	const runtime = resolveNousProviderRuntime({
		env: { NOUS_API_KEY: " sk-nous ", NOUS_INFERENCE_BASE_URL: "https://inference.example/v1/" },
		fetchFn: async (input, init) => {
			calls.push({ input: String(input), init });
			return jsonResponse({ data: [{ id: "live-a" }] });
		},
	});
	const outcome = await resolveStartupRegistration(runtime);
	assert.equal(outcome.reason, "startup-direct-key");
	assert.deepEqual(outcome.models.map((model) => model.id), ["live-a"]);
	assert.equal(calls[0].input, "https://inference.example/v1/models");
	assert.equal(calls[0].init.headers.Authorization, "Bearer sk-nous");
});

test("startup direct API key falls back for unavailable discovery and blanks for auth failure or empty catalog", async () => {
	const unavailable = await resolveStartupRegistration(
		resolveNousProviderRuntime({ env: { NOUS_API_KEY: "sk-nous" }, fetchFn: async () => jsonResponse({ error: "nope" }, { status: 500 }) }),
	);
	assert.ok(unavailable.models.length > 5);

	const authFailed = await resolveStartupRegistration(
		resolveNousProviderRuntime({ env: { NOUS_API_KEY: "bad" }, fetchFn: async () => jsonResponse({ error: "invalid" }, { status: 401 }) }),
	);
	assert.deepEqual(authFailed.models, []);

	const empty = await resolveStartupRegistration(
		resolveNousProviderRuntime({ env: { NOUS_API_KEY: "sk-nous" }, fetchFn: async () => jsonResponse({ data: [] }) }),
	);
	assert.deepEqual(empty.models, []);
});

test("OAuth credential registration applies stored catalog and credential base URL", () => {
	const runtime = resolveNousProviderRuntime({ env: { NOUS_INFERENCE_BASE_URL: "https://env.example/v1" }, now: () => 1000 });
	const outcome = resolveOAuthCredentialRegistration(
		{ type: "oauth", access: "agent-key", expires: 2000, inferenceBaseUrl: "https://credential.example/v1", modelCatalog: [storedModel("cached")] },
		runtime,
	);
	assert.equal(outcome.reason, "oauth-login-credentials");
	assert.equal(outcome.baseUrl, "https://credential.example/v1");
	assert.deepEqual(outcome.models.map((model) => model.id), ["cached"]);
	assert.equal(outcome.models[0].baseUrl, "https://credential.example/v1");
});

test("session policy skips missing auth storage and returns fallback models when no Nous credentials exist", async () => {
	const runtime = resolveNousProviderRuntime({ env: {} });
	assert.deepEqual(await resolveSessionRegistration({ runtime }), { kind: "skip", reason: "missing-auth-storage" });

	const apiKeyCalls = [];
	const outcome = await resolveSessionRegistration({
		runtime,
		authStorage: {
			getApiKey(provider, options) {
				apiKeyCalls.push({ provider, options });
				return undefined;
			},
			get: () => undefined,
		},
	});
	assert.deepEqual(apiKeyCalls, [{ provider: PROVIDER_ID, options: { includeFallback: false } }]);
	assert.equal(outcome.reason, "session-no-credentials");
	assert.ok(outcome.models.length > 5);
	assert.equal(outcome.models[0].baseUrl, "https://inference-api.nousresearch.com/v1");
});

test("session stored OAuth without exposed API key uses cached and fallback catalog policy", async () => {
	const runtime = resolveNousProviderRuntime({ env: { NOUS_INFERENCE_BASE_URL: "https://env.example/v1" }, now: () => 1000 });
	const cached = await resolveSessionRegistration({
		runtime,
		authStorage: {
			getApiKey: () => undefined,
			get: () => ({ type: "oauth", access: "agent-key", expires: 2000, modelCatalog: [storedModel("cached")] }),
		},
	});
	assert.equal(cached.reason, "session-stored-oauth");
	assert.deepEqual(cached.models.map((model) => model.id), ["cached"]);

	const fallback = await resolveSessionRegistration({
		runtime,
		authStorage: {
			getApiKey: () => undefined,
			get: () => ({ type: "oauth", access: "agent-key", expires: 2000, modelCatalogUnavailable: true }),
		},
	});
	assert.equal(fallback.reason, "session-stored-oauth");
	assert.ok(fallback.models.length > 5);

	const authFailed = await resolveSessionRegistration({
		runtime,
		authStorage: {
			getApiKey: () => undefined,
			get: () => ({ type: "oauth", access: "agent-key", expires: 2000, modelCatalogAuthFailed: true, modelCatalog: [storedModel("old")] }),
		},
	});
	assert.deepEqual(authFailed.models, []);
});

test("session OAuth lifecycle refresh returns changed credentials and refreshed registration", async () => {
	const runtime = resolveNousProviderRuntime({
		env: { NOUS_INFERENCE_BASE_URL: "https://inference.example/v1", NOUS_PORTAL_BASE_URL: "https://portal.example" },
		now: () => 1000,
		fetchFn: async (input) => {
			if (String(input) === "https://inference.example/v1/models") return jsonResponse({ data: [{ id: "refreshed" }] });
			return jsonResponse({ data: [] });
		},
	});
	const outcome = await resolveSessionRegistration({
		runtime,
		authStorage: {
			getApiKey: () => "agent-key",
			get: () => ({ type: "oauth", access: "agent-key", expires: 2000, inferenceBaseUrl: "https://inference.example/v1", modelCatalog: [storedModel("cached")] }),
		},
	});
	assert.equal(outcome.reason, "session-oauth-lifecycle");
	assert.deepEqual(outcome.models.map((model) => model.id), ["refreshed"]);
	assert.equal(outcome.credentialsToStore.modelCatalog[0].id, "refreshed");
});

test("session OAuth lifecycle refresh preserves stored credential portal client and inference boundary", async () => {
	const calls = [];
	const runtime = resolveNousProviderRuntime({
		env: {
			NOUS_INFERENCE_BASE_URL: "https://runtime-inference.example/v1",
			NOUS_PORTAL_BASE_URL: "https://runtime-portal.example",
			NOUS_CLIENT_ID: "runtime-client",
		},
		now: () => 2000,
		fetchFn: async (input, init = {}) => {
			const body = init.body?.toString?.() ?? String(init.body ?? "");
			calls.push({ input: String(input), init, body });
			if (String(input) === "https://credential-portal.example/api/oauth/token") {
				return jsonResponse({ access_token: "portal-access", expires_in: 3600, inference_base_url: "https://credential-inference.example/v1" });
			}
			if (String(input) === "https://credential-portal.example/api/oauth/agent-key") {
				return jsonResponse({ api_key: "refreshed-agent-key", expires_in: 3600, inference_base_url: "https://credential-inference.example/v1" });
			}
			if (String(input) === "https://credential-inference.example/v1/models") {
				return jsonResponse({ data: [{ id: "credential-boundary-model" }] });
			}
			throw new Error(`unexpected request ${input}`);
		},
	});

	const outcome = await resolveSessionRegistration({
		runtime,
		authStorage: {
			getApiKey: () => "expired-agent-key",
			get: () => ({
				type: "oauth",
				access: "expired-agent-key",
				expires: 1000,
				refresh: "refresh-token",
				portalBaseUrl: "https://credential-portal.example",
				inferenceBaseUrl: "https://credential-inference.example/v1",
				clientId: "credential-client",
				modelCatalog: [storedModel("cached", "https://credential-inference.example/v1")],
			}),
		},
	});

	assert.equal(outcome.reason, "session-oauth-lifecycle");
	assert.equal(outcome.baseUrl, "https://credential-inference.example/v1");
	assert.deepEqual(outcome.models.map((model) => model.id), ["credential-boundary-model"]);
	assert.equal(calls[0].input, "https://credential-portal.example/api/oauth/token");
	assert.match(calls[0].body, /client_id=credential-client/);
	assert.doesNotMatch(calls[0].body, /runtime-client/);
	assert.equal(calls[1].input, "https://credential-portal.example/api/oauth/agent-key");
	assert.equal(calls[2].input, "https://credential-inference.example/v1/models");
	assert.equal(outcome.credentialsToStore.portalBaseUrl, "https://credential-portal.example");
	assert.equal(outcome.credentialsToStore.clientId, "credential-client");
	assert.equal(outcome.credentialsToStore.inferenceBaseUrl, "https://credential-inference.example/v1");
});

test("session direct-key branch uses injected auth-storage API key and fetch", async () => {
	const calls = [];
	const runtime = resolveNousProviderRuntime({
		env: { NOUS_INFERENCE_BASE_URL: "https://direct.example/v1" },
		fetchFn: async (input, init) => {
			calls.push({ input: String(input), init });
			return jsonResponse({ data: [{ id: "direct" }] });
		},
	});
	const outcome = await resolveSessionRegistration({
		runtime,
		authStorage: { getApiKey: () => " direct-key ", get: () => undefined },
	});
	assert.equal(outcome.reason, "session-direct-key");
	assert.deepEqual(outcome.models.map((model) => model.id), ["direct"]);
	assert.equal(calls[0].input, "https://direct.example/v1/models");
	assert.equal(calls[0].init.headers.Authorization, "Bearer direct-key");
});
