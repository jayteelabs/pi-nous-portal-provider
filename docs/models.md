# Model Catalog

`@jayteelabs/pi-nous-portal-provider` treats Nous Portal as the authority for model availability and uses OpenRouter only as best-effort metadata.

## Sources

1. Nous Portal inference `/models`

   When `NOUS_API_KEY` is set, or after `/login nous-portal` mints an agent key, the package fetches:

   ```text
   <NOUS_INFERENCE_BASE_URL>/models
   ```

   This response is the allowlist. A model is registered only if Nous returned it.

2. OpenRouter public `/models`

   After the Nous list is parsed, the package fetches:

   ```text
   https://openrouter.ai/api/v1/models
   ```

   Matching model IDs enrich the Nous entries with display name, context window, max output, pricing, input modalities, and reasoning support. OpenRouter-only models are ignored.

3. Static fallback catalog

   If Pi has usable Nous credentials and Nous discovery is unavailable, the package uses the curated fallback list in `extensions/nous-portal/models.ts`. The fallback includes static capability hints for common reasoning and image-capable model families, but live Nous plus OpenRouter metadata wins whenever available. Without credentials, with invalid credentials, or after a successful empty Nous allowlist, the provider model list stays blank.

## Field Mapping

- `architecture.input_modalities` containing `image` maps to Pi `input: ["text", "image"]`.
- `supported_parameters` containing `reasoning` or `include_reasoning` maps to Pi `reasoning: true`.
- Reasoning models use `compat.thinkingFormat: "openrouter"` so Pi sends OpenRouter-style nested `reasoning` parameters through the Nous OpenAI-compatible endpoint.
- OpenRouter `pricing.prompt`, `pricing.completion`, `pricing.input_cache_read`, and `pricing.input_cache_write` are converted from per-token prices to Pi's per-million-token cost fields.
- `top_provider.max_completion_tokens` is preferred for `maxTokens`; model-level max-token fields are fallback values.
- `top_provider.context_length` or model-level context fields are used for `contextWindow`.

## Failure Behavior

OpenRouter metadata is optional. If it times out, returns an error, or has no matching model ID, the package keeps the Nous model entry unchanged. If authenticated Nous discovery fails because the service is unavailable or times out, the package falls back to the static catalog. If no credentials are present, credentials are rejected, or Nous returns an empty allowlist, the package keeps the Nous provider blank.

The package does not read `~/.hermes/auth.json`; Hermes is only an implementation reference.
