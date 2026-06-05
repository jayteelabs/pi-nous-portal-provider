# Model Catalog

`@jayteelabs/pi-nous-portal-provider` treats Nous Portal as the authority for model availability and uses OpenRouter only as best-effort metadata.

## Sources

1. Nous Portal inference `/models`

   When `NOUS_API_KEY` is set, or after `/login nous-portal` mints an agent key, the package fetches:

   ```text
   <NOUS_INFERENCE_BASE_URL>/models
   ```

   This response is the allowlist. A model is registered only if Nous returned it. With OAuth, the login result stores the catalog in Pi auth storage, re-registers the provider immediately, and Pi's post-login registry refresh applies the cached catalog.

2. OpenRouter public `/models`

   After the Nous list is parsed, the package fetches:

   ```text
   https://openrouter.ai/api/v1/models
   ```

   Matching model IDs enrich the Nous entries with display name, context window, max output, pricing, input modalities, and reasoning support. OpenRouter-only models are ignored.

3. Static fallback catalog

   If Pi has usable Nous credentials and Nous discovery is unavailable, the package uses the curated fallback list in `extensions/nous-portal/models.ts`. The fallback includes static capability hints for common reasoning and image-capable model families, but live Nous plus OpenRouter metadata wins whenever available. The fallback is also registered during unauthenticated startup/session registration under the direct-key provider alias so Pi can discover Nous in the API-key `/login` flow. Pi builds API-key login options from providers with registered models, and filters custom OAuth provider IDs out of that list, so the package registers `nous-portal-api-key` without OAuth while displaying it as `Nous Research Portal`. Expired or invalid OAuth credentials, direct-key auth failures, or a successful empty Nous allowlist keep the OAuth provider model list blank.

## Refresh Lifecycle

- Direct `NOUS_API_KEY`: the async extension factory fetches the live catalog during startup and falls back only for non-auth discovery failures.
- API-key `/login`: Pi cannot show a single custom provider ID in both the subscription and API-key pickers, so direct-key login uses the internal provider ID `nous-portal-api-key` with display name `Nous Research Portal`.
- OAuth login: the provider keeps unauthenticated startup models on the static fallback catalog for `/login` API-key discoverability, then re-registers the returned OAuth model catalog as soon as Portal OAuth completes. Pi's own post-login `modelRegistry.refresh()` then replays that registered catalog with the stored OAuth credentials.
- Interactive session initialization: on `session_start`, the extension asks Pi auth storage for `nous-portal` credentials, lets Pi refresh expired OAuth credentials if needed, and fetches the current Nous `/models` catalog with the resulting agent key. Successful discovery updates the cached catalog, discovery failure marks the catalog unavailable and uses fallback models only when credentials are usable, missing credentials keep fallback models registered for API-key login discovery, and invalid credentials re-register a blank OAuth provider.
- Cold `pi --list-models` without `NOUS_API_KEY`: Pi does not expose auth storage to the extension factory, so this package avoids reading Pi internals and uses the static fallback catalog until live direct-key or stored OAuth discovery becomes available.

## Field Mapping

- `architecture.input_modalities` containing `image` maps to Pi `input: ["text", "image"]`.
- `supported_parameters` containing `reasoning` or `include_reasoning` maps to Pi `reasoning: true`.
- Reasoning models use `compat.thinkingFormat: "openrouter"` so Pi sends OpenRouter-style nested `reasoning` parameters through the Nous OpenAI-compatible endpoint.
- OpenRouter `pricing.prompt`, `pricing.completion`, `pricing.input_cache_read`, and `pricing.input_cache_write` are converted from per-token prices to Pi's per-million-token cost fields.
- `top_provider.max_completion_tokens` is preferred for `maxTokens`; model-level max-token fields are fallback values.
- `top_provider.context_length` or model-level context fields are used for `contextWindow`.

## Failure Behavior

OpenRouter metadata is optional. If it times out, returns an error, or has no matching model ID, the package keeps the Nous model entry unchanged. If authenticated Nous discovery fails because the service is unavailable or times out, the package falls back to the static catalog. If no credentials are present, credentials are expired or rejected, or Nous returns an empty allowlist, the package keeps the Nous provider blank.

The package does not read `~/.hermes/auth.json`; Hermes is only an implementation reference.
