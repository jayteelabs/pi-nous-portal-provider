import assert from "node:assert/strict";
import test from "node:test";

import {
	DEFAULT_INFERENCE_BASE_URL,
	FALLBACK_MODEL_IDS,
	OPENAI_COMPAT,
	OPENROUTER_REASONING_COMPAT,
	applyOpenRouterMetadata,
	buildFallbackModels,
	fetchModelCatalog,
	parseOpenRouterModelMetadata,
	parseModelCatalog,
} from "../extensions/nous-portal/models.ts";
import {
	applyCatalogToProviderModels,
	refreshOAuthCatalog,
	resolveDirectCatalog,
	selectStoredCredentialCatalog,
} from "../extensions/nous-portal/model-catalog-policy.ts";

function jsonResponse(payload, init = {}) {
	return new Response(JSON.stringify(payload), {
		status: init.status ?? 200,
		headers: { "content-type": "application/json" },
	});
}

test("fallback catalog maps curated Nous models with static capability hints", () => {
	const models = buildFallbackModels("https://example.test/v1/");
	assert.equal(models.length, FALLBACK_MODEL_IDS.length);
	assert.equal(models[0].id, FALLBACK_MODEL_IDS[0]);
	assert.equal(models[0].baseUrl, "https://example.test/v1");
	assert.equal(models[0].api, "openai-completions");
	assert.equal(models[0].reasoning, true);
	assert.deepEqual(models[0].input, ["text", "image"]);
	assert.deepEqual(models[0].compat, OPENROUTER_REASONING_COMPAT);

	const textOnly = models.find((model) => model.id === "minimax/minimax-m2.5");
	assert.equal(textOnly.reasoning, false);
	assert.deepEqual(textOnly.input, ["text"]);
	assert.deepEqual(textOnly.compat, OPENAI_COMPAT);
});

test("parseModelCatalog includes all valid returned model ids and de-duplicates in response order", () => {
	const models = parseModelCatalog(
		{
			data: [
				{ id: "hermes-internal", context_window: "2048", max_tokens: 128 },
				{ id: "vision-model", input_modalities: ["text", "image"] },
				{ id: "vision-model" },
				{ id: "  " },
				{},
			],
		},
		DEFAULT_INFERENCE_BASE_URL,
	);
	assert.deepEqual(
		models.map((model) => model.id),
		["hermes-internal", "vision-model"],
	);
	assert.equal(models[0].contextWindow, 2048);
	assert.equal(models[0].maxTokens, 128);
	assert.deepEqual(models[1].input, ["text", "image"]);
});

test("parseModelCatalog maps OpenRouter-shaped metadata when Nous returns it directly", () => {
	const models = parseModelCatalog(
		{
			data: [
				{
					id: "openrouter-shaped",
					name: "OpenRouter Shaped",
					context_length: 262144,
					architecture: { input_modalities: ["text", "image"] },
					top_provider: { max_completion_tokens: 32768 },
					supported_parameters: ["tools", "reasoning", "include_reasoning"],
					pricing: {
						prompt: "0.00000095",
						completion: "0.000004",
						input_cache_read: "0.00000016",
						input_cache_write: "0.00000095",
					},
				},
			],
		},
		DEFAULT_INFERENCE_BASE_URL,
	);

	assert.equal(models[0].name, "OpenRouter Shaped");
	assert.equal(models[0].reasoning, true);
	assert.deepEqual(models[0].input, ["text", "image"]);
	assert.equal(models[0].contextWindow, 262144);
	assert.equal(models[0].maxTokens, 32768);
	assert.deepEqual(models[0].cost, { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0.95 });
	assert.deepEqual(models[0].compat, OPENROUTER_REASONING_COMPAT);
});

test("OpenRouter metadata enriches matching Nous models without adding extra models", () => {
	const nousModels = parseModelCatalog(
		{ data: [{ id: "match" }, { id: "nous-only", input_modalities: ["text", "image"] }] },
		"https://inference.example/v1",
	);
	const metadata = parseOpenRouterModelMetadata({
		data: [
			{
				id: "match",
				name: "Matched Model",
				context_length: 1000000,
				architecture: { input_modalities: ["text", "image"] },
				top_provider: { max_completion_tokens: 65536 },
				supported_parameters: ["tools", "reasoning"],
				pricing: { prompt: "0.0000002", completion: "0.0000005" },
			},
			{
				id: "openrouter-only",
				name: "Must Not Be Added",
				supported_parameters: ["tools", "reasoning"],
			},
		],
	});

	const enriched = applyOpenRouterMetadata(nousModels, metadata);
	assert.deepEqual(
		enriched.map((model) => model.id),
		["match", "nous-only"],
	);
	assert.equal(enriched[0].name, "Matched Model");
	assert.equal(enriched[0].reasoning, true);
	assert.deepEqual(enriched[0].input, ["text", "image"]);
	assert.equal(enriched[0].contextWindow, 1000000);
	assert.equal(enriched[0].maxTokens, 65536);
	assert.ok(Math.abs(enriched[0].cost.input - 0.2) < 1e-12);
	assert.equal(enriched[0].baseUrl, "https://inference.example/v1");
	assert.equal(enriched[1].name, "nous-only");
	assert.deepEqual(enriched[1].input, ["text", "image"]);
});

test("fetchModelCatalog calls Nous /models with bearer auth and enriches from OpenRouter", async () => {
	const calls = [];
	const fetchFn = async (input, init) => {
		calls.push({ input: String(input), init });
		if (calls.length === 1) return jsonResponse({ data: [{ id: "live-a" }] });
		return jsonResponse({
			data: [
				{
					id: "live-a",
					name: "Live A",
					context_length: 200000,
					supported_parameters: ["tools", "reasoning"],
				},
			],
		});
	};

	const models = await fetchModelCatalog("sk-nous", "https://inference.example/v1/", { fetchFn });
	assert.equal(models[0].id, "live-a");
	assert.equal(models[0].name, "Live A");
	assert.equal(models[0].reasoning, true);
	assert.equal(models[0].contextWindow, 200000);
	assert.equal(calls[0].input, "https://inference.example/v1/models");
	assert.equal(calls[0].init.headers.Authorization, "Bearer sk-nous");
	assert.equal(calls[0].init.headers.Accept, "application/json");
	assert.equal(calls[1].input, "https://openrouter.ai/api/v1/models");
	assert.equal(calls[1].init.headers.Authorization, undefined);
});

test("fetchModelCatalog keeps Nous catalog when OpenRouter metadata fails", async () => {
	let count = 0;
	const fetchFn = async () => {
		count += 1;
		if (count === 1) return jsonResponse({ data: [{ id: "live-a" }] });
		return jsonResponse({ error: "nope" }, { status: 503 });
	};

	const models = await fetchModelCatalog("sk-nous", "https://inference.example/v1/", { fetchFn });
	assert.equal(models[0].id, "live-a");
	assert.equal(models[0].name, "live-a");
	assert.equal(count, 2);
});

test("fetchModelCatalog rejects when discovery times out", async () => {
	const fetchFn = async (_input, init) =>
		new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
		});

	await assert.rejects(
		fetchModelCatalog("sk-nous", "https://inference.example/v1", { fetchFn, timeoutMs: 1 }),
		/Model discovery timed out/,
	);
});


test("catalog policy resolves direct key outcomes without leaking fallback for blank or auth failures", async () => {
	assert.deepEqual(await resolveDirectCatalog({ apiKey: "" }), []);

	const live = await resolveDirectCatalog({
		apiKey: "sk-nous",
		baseUrl: "https://inference.example/v1/",
		fetchFn: async (input) => {
			if (String(input).endsWith("/models")) return jsonResponse({ data: [{ id: "live-a" }] });
			return jsonResponse({ data: [] });
		},
	});
	assert.deepEqual(live.map((model) => model.id), ["live-a"]);
	assert.equal(live[0].baseUrl, "https://inference.example/v1");

	const authFailure = await resolveDirectCatalog({
		apiKey: "bad-key",
		fetchFn: async () => jsonResponse({ error: "invalid_api_key" }, { status: 403 }),
	});
	assert.deepEqual(authFailure, []);

	const unavailable = await resolveDirectCatalog({
		apiKey: "sk-nous",
		baseUrl: "https://fallback.example/v1",
		fetchFn: async () => jsonResponse({ error: "unavailable" }, { status: 503 }),
	});
	assert.equal(unavailable.length, FALLBACK_MODEL_IDS.length);
	assert.equal(unavailable[0].baseUrl, "https://fallback.example/v1");
});

test("catalog policy records OAuth discovery success versus unavailable without fallback", async () => {
	const now = Date.parse("2026-01-01T00:00:00.000Z");
	const empty = await refreshOAuthCatalog({
		apiKey: "agent-key",
		fetchFn: async (input) => {
			if (String(input).endsWith("/models")) return jsonResponse({ data: [] });
			return jsonResponse({ data: [{ id: "openrouter-only" }] });
		},
		now: () => now,
	});
	assert.deepEqual(empty.catalog, []);
	assert.equal(empty.unavailable, false);
	assert.equal(empty.fetchedAt, now);

	const unavailable = await refreshOAuthCatalog({
		apiKey: "agent-key",
		fetchFn: async () => jsonResponse({ error: "unavailable" }, { status: 503 }),
	});
	assert.deepEqual(unavailable, { unavailable: true });
});


test("catalog policy marks OAuth /models auth failures without enabling fallback", async () => {
	for (const status of [401, 403]) {
		const authFailure = await refreshOAuthCatalog({
			apiKey: "revoked-agent-key",
			fetchFn: async () => jsonResponse({ error: "unauthorized" }, { status }),
		});

		assert.deepEqual(authFailure, { unavailable: false, authFailed: true });
	}
});

test("catalog policy selects stored, fallback, and blank credential catalogs deterministically", () => {
	const now = Date.parse("2026-01-01T00:00:00.000Z");
	const stored = {
		id: "stored-model",
		name: "Stored Model",
		api: "openai-completions",
		baseUrl: "https://old.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};

	assert.deepEqual(selectStoredCredentialCatalog({}, { now: () => now }), []);
	assert.deepEqual(
		selectStoredCredentialCatalog({ access: "agent", expires: now - 1, modelCatalogUnavailable: true }, { now: () => now }),
		[],
	);
	assert.deepEqual(
		selectStoredCredentialCatalog(
			{
				access: "agent",
				expires: now + 60_000,
				inferenceBaseUrl: "https://fresh.example/v1",
				modelCatalog: [stored],
			},
			{ now: () => now },
		),
		[{ ...stored, baseUrl: "https://fresh.example/v1" }],
	);
	assert.deepEqual(
		selectStoredCredentialCatalog(
			{
				access: "agent",
				expires: now + 60_000,
				modelCatalog: [stored],
				modelCatalogAuthFailed: true,
				modelCatalogUnavailable: true,
			},
			{ now: () => now },
		),
		[],
	);
	assert.deepEqual(
		selectStoredCredentialCatalog(
			{ access: "agent", expires: now + 60_000, modelCatalog: [], modelCatalogUnavailable: false },
			{ now: () => now },
		),
		[],
	);
	assert.equal(
		selectStoredCredentialCatalog(
			{ access: "agent", expires: now + 60_000, modelCatalogUnavailable: true },
			{ now: () => now },
		).length,
		FALLBACK_MODEL_IDS.length,
	);
});

test("catalog policy raw compatibility ignores kind collisions and remains fail-closed", () => {
	const now = Date.parse("2026-01-01T00:00:00.000Z");
	const models = [
		{ provider: "openai", id: "gpt", baseUrl: "https://api.openai.com/v1", api: "openai-completions" },
		{ provider: "nous-portal", id: "old-nous", baseUrl: "https://old.example/v1", api: "openai-completions" },
	];
	const collisionBase = {
		kind: "fallback",
		reason: "catalog-unavailable",
		baseUrl: "https://collision.example/v1",
		modelCatalogUnavailable: true,
	};

	for (const credentials of [
		{ ...collisionBase, access: "agent", expires: now + 60_000, modelCatalogAuthFailed: true },
		{ ...collisionBase, access: "", expires: now + 60_000 },
		{ ...collisionBase, access: "agent", expires: now - 1 },
	]) {
		const modified = applyCatalogToProviderModels(models, credentials, { now: () => now });
		assert.deepEqual(modified, [models[0]]);
	}
});

test("catalog policy apply preserves non-Nous models and replaces only the Nous slice", () => {
	const now = Date.parse("2026-01-01T00:00:00.000Z");
	const models = [
		{ provider: "openai", id: "gpt", baseUrl: "https://api.openai.com/v1", api: "openai-completions" },
		{ provider: "nous-portal", id: "old-nous", baseUrl: "https://old.example/v1", api: "openai-completions" },
	];
	const modified = applyCatalogToProviderModels(
		models,
		{
			access: "agent",
			expires: now + 60_000,
			inferenceBaseUrl: "https://oauth.example/v1",
			modelCatalogUnavailable: true,
		},
		{ now: () => now },
	);

	assert.equal(modified[0], models[0]);
	assert.equal(modified[1].provider, "nous-portal");
	assert.equal(modified[1].baseUrl, "https://oauth.example/v1");
});
