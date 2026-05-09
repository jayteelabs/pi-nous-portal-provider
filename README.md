# @jayteelabs/pi-nous-portal-provider

Pi package that registers the `nous-portal` provider for Nous Research Portal.

## Install

```sh
pi install npm:@jayteelabs/pi-nous-portal-provider
```

## Usage

```sh
NOUS_API_KEY=... pi -p nous-portal -m openai/gpt-5.5
pi -e ./pi-nous-portal-provider --list-models
```

For Portal OAuth, run Pi and use:

```text
/login nous-portal
```

## Configuration

- `NOUS_API_KEY`: direct inference API key.
- `NOUS_PORTAL_BASE_URL`: defaults to `https://portal.nousresearch.com`.
- `NOUS_INFERENCE_BASE_URL`: defaults to `https://inference-api.nousresearch.com/v1`.
- `NOUS_CLIENT_ID`: defaults to `hermes-cli` because it doesn't accept anything else currently.
- `NOUS_MIN_KEY_TTL_SECONDS`: defaults to `1800`.

## Models

Nous Portal `/models` is the model allowlist. Matching OpenRouter `/models`
entries enrich that allowlist with context, pricing, image input, and reasoning
metadata. See [docs/models.md](docs/models.md).
