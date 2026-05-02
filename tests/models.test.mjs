import assert from "node:assert/strict";
import test from "node:test";

import {
	DEFAULT_INFERENCE_BASE_URL,
	FALLBACK_MODEL_IDS,
	OPENAI_COMPAT,
	buildFallbackModels,
	fetchModelCatalog,
	parseModelCatalog,
} from "../extensions/nous-portal/models.ts";

function jsonResponse(payload, init = {}) {
	return new Response(JSON.stringify(payload), {
		status: init.status ?? 200,
		headers: { "content-type": "application/json" },
	});
}

test("fallback catalog maps curated Nous models with conservative OpenAI-compatible defaults", () => {
	const models = buildFallbackModels("https://example.test/v1/");
	assert.equal(models.length, FALLBACK_MODEL_IDS.length);
	assert.equal(models[0].id, FALLBACK_MODEL_IDS[0]);
	assert.equal(models[0].baseUrl, "https://example.test/v1");
	assert.equal(models[0].api, "openai-completions");
	assert.equal(models[0].reasoning, false);
	assert.deepEqual(models[0].input, ["text"]);
	assert.deepEqual(models[0].compat, OPENAI_COMPAT);
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

test("fetchModelCatalog calls /models with bearer auth", async () => {
	const calls = [];
	const fetchFn = async (input, init) => {
		calls.push({ input: String(input), init });
		return jsonResponse({ data: [{ id: "live-a" }] });
	};

	const models = await fetchModelCatalog("sk-nous", "https://inference.example/v1/", { fetchFn });
	assert.equal(models[0].id, "live-a");
	assert.equal(calls[0].input, "https://inference.example/v1/models");
	assert.equal(calls[0].init.headers.Authorization, "Bearer sk-nous");
	assert.equal(calls[0].init.headers.Accept, "application/json");
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
