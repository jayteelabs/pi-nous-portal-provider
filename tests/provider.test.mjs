import assert from "node:assert/strict";
import test from "node:test";

import nousPortalProvider, { PROVIDER_ID, PROVIDER_NAME } from "../extensions/nous-portal/index.ts";

function jsonResponse(payload, init = {}) {
	return new Response(JSON.stringify(payload), {
		status: init.status ?? 200,
		headers: { "content-type": "application/json" },
	});
}

function capturePi() {
	const registrations = [];
	return {
		registrations,
		pi: {
			registerProvider(id, config) {
				registrations.push({ id, config });
			},
		},
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

test("provider registration uses nous-portal, NOUS_API_KEY, OAuth hooks, and blank models without auth", async () => {
	await withEnv({ NOUS_API_KEY: undefined, NOUS_INFERENCE_BASE_URL: undefined }, async () => {
		const { pi, registrations } = capturePi();
		await nousPortalProvider(pi);
		assert.equal(registrations.length, 1);
		const { id, config } = registrations[0];
		assert.equal(id, PROVIDER_ID);
		assert.equal(config.name, PROVIDER_NAME);
		assert.equal(config.baseUrl, "https://inference-api.nousresearch.com/v1");
		assert.equal(config.apiKey, "NOUS_API_KEY");
		assert.equal(config.api, "openai-completions");
		assert.deepEqual(config.models, []);
		assert.equal(config.oauth.name, PROVIDER_NAME);
		assert.equal(typeof config.oauth.login, "function");
		assert.equal(typeof config.oauth.refreshToken, "function");
		assert.equal(typeof config.oauth.getApiKey, "function");
		assert.equal(typeof config.oauth.modifyModels, "function");
	});
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
