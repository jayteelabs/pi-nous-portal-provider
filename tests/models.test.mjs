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
