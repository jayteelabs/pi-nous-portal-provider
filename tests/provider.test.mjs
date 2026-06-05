import assert from "node:assert/strict";
import test from "node:test";

import nousPortalProvider, { DIRECT_API_KEY_PROVIDER_ID, PROVIDER_ID, PROVIDER_NAME } from "../extensions/nous-portal/index.ts";

function jsonResponse(payload, init = {}) {
	return new Response(JSON.stringify(payload), {
		status: init.status ?? 200,
		headers: { "content-type": "application/json" },
	});
}

function capturePi() {
	const registrations = [];
	const handlers = new Map();
	return {
		registrations,
		handlers,
		pi: {
			registerProvider(id, config) {
				registrations.push({ id, config });
			},
			on(event, handler) {
				handlers.set(event, handler);
			},
		},
	};
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

async function withEnv(env, fn) {
	const previous = {};
	for (const key of Object.keys(env)) {
		previous[key] = process.env[key];
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function getApiKeyLoginProviderOptionsLikePi(registrations) {
	const oauthProviderIds = new Set(registrations.filter(({ config }) => config.oauth).map(({ id }) => id));
	const modelProviders = new Set();
	for (const { id, config } of registrations) {
		if (config.models?.length > 0) modelProviders.add(id);
	}

	return [...modelProviders]
		.filter((providerId) => !oauthProviderIds.has(providerId))
		.map((providerId) => {
			const registration = registrations.find(({ id }) => id === providerId);
			return {
				id: providerId,
				name: registration?.config.name ?? registration?.config.oauth?.name ?? providerId,
				authType: "api_key",
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

test("provider registration uses nous-portal, NOUS_API_KEY, OAuth hooks, and fallback models for login discovery without auth", async () => {
	await withEnv({ NOUS_API_KEY: undefined, NOUS_INFERENCE_BASE_URL: undefined }, async () => {
		const { pi, registrations } = capturePi();
		await nousPortalProvider(pi);
		assert.equal(registrations.length, 2);
		const { id, config } = registrations[0];
		assert.equal(id, PROVIDER_ID);
		assert.equal(config.name, PROVIDER_NAME);
		assert.equal(config.baseUrl, "https://inference-api.nousresearch.com/v1");
		assert.equal(config.apiKey, "$NOUS_API_KEY");
		assert.equal(config.api, "openai-completions");
		assert.ok(config.models.length > 5);
		assert.equal(config.models[0].baseUrl, "https://inference-api.nousresearch.com/v1");
		assert.equal(config.oauth.name, PROVIDER_NAME);
		assert.equal(typeof config.oauth.login, "function");
		assert.equal(typeof config.oauth.refreshToken, "function");
		assert.equal(typeof config.oauth.getApiKey, "function");
		assert.equal(typeof config.oauth.modifyModels, "function");

		const { id: apiKeyProviderId, config: apiKeyConfig } = registrations[1];
		assert.equal(apiKeyProviderId, DIRECT_API_KEY_PROVIDER_ID);
		assert.equal(apiKeyConfig.name, PROVIDER_NAME);
		assert.equal(apiKeyConfig.apiKey, "$NOUS_API_KEY");
		assert.equal(apiKeyConfig.oauth, undefined);
		assert.ok(apiKeyConfig.models.length > 5);
	});
});

test("provider registration includes a Pi-visible API-key login option", async () => {
	await withEnv({ NOUS_API_KEY: undefined, NOUS_INFERENCE_BASE_URL: undefined }, async () => {
		const { pi, registrations } = capturePi();
		await nousPortalProvider(pi);

		const apiKeyOptions = getApiKeyLoginProviderOptionsLikePi(registrations);
		assert.deepEqual(apiKeyOptions.map((option) => option.name), [PROVIDER_NAME]);
		assert.equal(apiKeyOptions[0].id, DIRECT_API_KEY_PROVIDER_ID);
		assert.equal(apiKeyOptions[0].authType, "api_key");
	});
});

test("OAuth login re-registers the provider with the returned model catalog", async () => {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		const url = String(input);
		if (url.endsWith("/api/oauth/device/code")) {
			return jsonResponse({
				device_code: "device-code",
				user_code: "USER-CODE",
				verification_uri: "https://portal.example/verify",
				verification_uri_complete: "https://portal.example/verify?user_code=USER-CODE",
				expires_in: 600,
				interval: 1,
			});
		}
		if (url.endsWith("/api/oauth/token")) {
			return jsonResponse({
				access_token: "portal-access",
				refresh_token: "portal-refresh",
				expires_in: 3600,
			});
		}
		if (url.endsWith("/api/oauth/agent-key")) {
			return jsonResponse({
				api_key: "agent-key",
				expires_in: 3600,
				inference_base_url: "https://inference.example/v1",
			});
		}
		if (url === "https://inference.example/v1/models") return jsonResponse({ data: [{ id: "live-model" }] });
		return jsonResponse({ data: [] });
	};
	try {
		await withEnv(
			{
				NOUS_API_KEY: undefined,
				NOUS_PORTAL_BASE_URL: "https://portal.example",
				NOUS_INFERENCE_BASE_URL: "https://inference.example/v1",
			},
			async () => {
				const { pi, registrations } = capturePi();
				await nousPortalProvider(pi);
				assert.ok(registrations[0].config.models.length > 5);
				assert.equal(registrations[0].config.models[0].baseUrl, "https://inference.example/v1");

				const credentials = await registrations[0].config.oauth.login({
					onAuth: () => {},
					onPrompt: async () => "",
					onDeviceCode: () => {},
				});

				assert.equal(credentials.modelCatalog[0].id, "live-model");
				assert.equal(registrations.length, 3);
				assert.equal(registrations[1].id, DIRECT_API_KEY_PROVIDER_ID);
				assert.equal(registrations[2].id, PROVIDER_ID);
				assert.deepEqual(
					registrations[2].config.models.map((model) => model.id),
					["live-model"],
				);
				assert.equal(registrations[2].config.baseUrl, "https://inference.example/v1");
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("session_start refreshes and re-registers OAuth models from auth storage", async () => {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		if (String(input) === "https://inference.example/v1/models") return jsonResponse({ data: [{ id: "refreshed-model" }] });
		return jsonResponse({ data: [] });
	};
	try {
		await withEnv({ NOUS_API_KEY: undefined, NOUS_INFERENCE_BASE_URL: undefined }, async () => {
			const { pi, registrations, handlers } = capturePi();
			await nousPortalProvider(pi);
			let credentials = {
				type: "oauth",
				access: "agent-key",
				expires: Date.now() + 60_000,
				inferenceBaseUrl: "https://inference.example/v1",
				modelCatalog: [storedModel("cached-model")],
			};
			const apiKeyCalls = [];

			await handlers.get("session_start")?.(
				{ reason: "startup" },
				{
					modelRegistry: {
						authStorage: {
							getApiKey(provider, options) {
								apiKeyCalls.push({ provider, options });
								return "agent-key";
							},
							get(provider) {
								return provider === PROVIDER_ID ? credentials : undefined;
							},
							set(provider, updated) {
								if (provider === PROVIDER_ID) credentials = updated;
							},
						},
					},
				},
			);

			assert.deepEqual(apiKeyCalls, [{ provider: PROVIDER_ID, options: { includeFallback: false } }]);
			assert.equal(credentials.modelCatalog[0].id, "refreshed-model");
			assert.equal(credentials.modelCatalogUnavailable, false);
			assert.equal(registrations.length, 3);
			assert.equal(registrations[2].id, PROVIDER_ID);
			assert.deepEqual(
				registrations[2].config.models.map((model) => model.id),
				["refreshed-model"],
			);
			assert.equal(registrations[2].config.models[0].baseUrl, "https://inference.example/v1");
		});
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("session_start keeps fallback models visible for API-key login when auth storage has no Nous credentials", async () => {
	await withEnv({ NOUS_API_KEY: undefined, NOUS_INFERENCE_BASE_URL: undefined }, async () => {
		const { pi, registrations, handlers } = capturePi();
		await nousPortalProvider(pi);

		await handlers.get("session_start")?.(
			{ reason: "startup" },
			{
				modelRegistry: {
					authStorage: {
						getApiKey: () => undefined,
						get: () => undefined,
					},
				},
			},
		);

		assert.equal(registrations.length, 4);
		assert.equal(registrations[2].id, PROVIDER_ID);
		assert.equal(registrations[3].id, DIRECT_API_KEY_PROVIDER_ID);
		assert.ok(registrations[3].config.models.length > 5);
		assert.equal(registrations[3].config.models[0].baseUrl, "https://inference-api.nousresearch.com/v1");
	});
});

test("session_start registers fallback models when cached OAuth catalog is unavailable", async () => {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async () => jsonResponse({ error: "unavailable" }, { status: 503 });
	try {
		await withEnv({ NOUS_API_KEY: undefined, NOUS_INFERENCE_BASE_URL: undefined }, async () => {
			const { pi, registrations, handlers } = capturePi();
			await nousPortalProvider(pi);
			let credentials = {
				type: "oauth",
				access: "agent-key",
				expires: Date.now() + 60_000,
				inferenceBaseUrl: "https://inference.example/v1",
			};

			await handlers.get("session_start")?.(
				{ reason: "startup" },
				{
					modelRegistry: {
						authStorage: {
							getApiKey: () => "agent-key",
							get: () => credentials,
							set: (_provider, updated) => {
								credentials = updated;
							},
						},
					},
				},
			);

			assert.equal(credentials.modelCatalogUnavailable, true);
			assert.equal(registrations.length, 3);
			assert.equal(registrations[2].id, PROVIDER_ID);
			assert.ok(registrations[2].config.models.length > 5);
			assert.equal(registrations[2].config.models[0].baseUrl, "https://inference.example/v1");
		});
	} finally {
		globalThis.fetch = previousFetch;
	}
});


test("session_start applies env inference base URL to legacy stored OAuth fallback models", async () => {
	await withEnv(
		{ NOUS_API_KEY: undefined, NOUS_INFERENCE_BASE_URL: "https://env-inference.example/v1/" },
		async () => {
			const { pi, registrations, handlers } = capturePi();
			await nousPortalProvider(pi);
			const credentials = {
				type: "oauth",
				access: "agent-key",
				expires: Date.now() + 60_000,
				modelCatalogUnavailable: true,
			};

			await handlers.get("session_start")?.(
				{ reason: "startup" },
				{
					modelRegistry: {
						authStorage: {
							getApiKey: () => undefined,
							get: () => credentials,
						},
					},
				},
			);

			assert.equal(registrations.length, 3);
			assert.equal(registrations[2].id, PROVIDER_ID);
			assert.ok(registrations[2].config.models.length > 5);
			assert.equal(registrations[2].config.baseUrl, "https://env-inference.example/v1");
			assert.equal(registrations[2].config.models[0].baseUrl, "https://env-inference.example/v1");
		},
	);
});

test("session_start keeps OAuth models blank on /models auth failure", async () => {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async () => jsonResponse({ error: "revoked" }, { status: 401 });
	try {
		await withEnv({ NOUS_API_KEY: undefined, NOUS_INFERENCE_BASE_URL: undefined }, async () => {
			const { pi, registrations, handlers } = capturePi();
			await nousPortalProvider(pi);
			let credentials = {
				type: "oauth",
				access: "agent-key",
				expires: Date.now() + 60_000,
				inferenceBaseUrl: "https://inference.example/v1",
				modelCatalog: [storedModel("cached-model")],
				modelCatalogUnavailable: true,
			};

			await handlers.get("session_start")?.(
				{ reason: "startup" },
				{
					modelRegistry: {
						authStorage: {
							getApiKey: () => "agent-key",
							get: () => credentials,
							set: (_provider, updated) => {
								credentials = updated;
							},
						},
					},
				},
			);

			assert.equal(credentials.modelCatalogAuthFailed, true);
			assert.equal(credentials.modelCatalogUnavailable, false);
			assert.deepEqual(credentials.modelCatalog, []);
			assert.equal(registrations.length, 3);
			assert.equal(registrations[2].id, PROVIDER_ID);
			assert.deepEqual(registrations[2].config.models, []);
		});
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("startup model discovery uses NOUS_API_KEY and live /models when available", async () => {
	const previousFetch = globalThis.fetch;
	const calls = [];
	globalThis.fetch = async (input, init) => {
		calls.push({ input: String(input), init });
		return jsonResponse({ data: [{ id: "live-a" }, { id: "live-b" }] });
	};
	try {
		await withEnv(
			{
				NOUS_API_KEY: "sk-nous",
				NOUS_INFERENCE_BASE_URL: "https://inference.example/v1/",
			},
			async () => {
				const { pi, registrations } = capturePi();
				await nousPortalProvider(pi);
				const config = registrations[0].config;
				assert.deepEqual(
					config.models.map((model) => model.id),
					["live-a", "live-b"],
				);
				assert.equal(config.baseUrl, "https://inference.example/v1");
				assert.equal(config.apiKey, "$NOUS_API_KEY");
				assert.equal(calls[0].input, "https://inference.example/v1/models");
				assert.equal(calls[0].init.headers.Authorization, "Bearer sk-nous");
			},
		);
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("startup model discovery stays blank when Nous returns an empty allowlist", async () => {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async () => jsonResponse({ data: [] });
	try {
		await withEnv({ NOUS_API_KEY: "sk-nous" }, async () => {
			const { pi, registrations } = capturePi();
			await nousPortalProvider(pi);
			assert.deepEqual(registrations[0].config.models, []);
		});
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("startup model discovery falls back to static models when authenticated discovery is unavailable", async () => {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async () => jsonResponse({ error: "nope" }, { status: 500 });
	try {
		await withEnv({ NOUS_API_KEY: "sk-nous" }, async () => {
			const { pi, registrations } = capturePi();
			await nousPortalProvider(pi);
			const config = registrations[0].config;
			assert.ok(config.models.length > 5);
			assert.notEqual(config.models[0].id, "live-a");
		});
	} finally {
		globalThis.fetch = previousFetch;
	}
});

test("startup model discovery stays blank when direct API key auth fails", async () => {
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async () => jsonResponse({ error: "invalid_api_key" }, { status: 401 });
	try {
		await withEnv({ NOUS_API_KEY: "bad-key" }, async () => {
			const { pi, registrations } = capturePi();
			await nousPortalProvider(pi);
			assert.deepEqual(registrations[0].config.models, []);
		});
	} finally {
		globalThis.fetch = previousFetch;
	}
});
