# @jayteelabs/pi-nous-portal-provider

Pi package that registers the `nous-portal` provider for Nous Research Portal.

## Install

```sh
pi install npm:@jayteelabs/pi-nous-portal-provider
```

## Usage

```sh
# Export NOUS_API_KEY from your shell or secrets manager before running Pi.
pi -p nous-portal -m openai/gpt-5.5
pi -e ./pi-nous-portal-provider --list-models
```

For Portal OAuth, run Pi and choose the subscription flow:

```text
/login → Use a subscription → Nous Research Portal
```

For a direct inference key, choose the API-key flow:

```text
/login → Use an API key → Nous Research Portal
```

Without `NOUS_API_KEY` or stored Portal OAuth credentials, the provider
registers its static fallback catalog under a direct-key provider alias so Pi
can discover Nous in the API-key `/login` flow. After an interactive Portal
OAuth login, Pi refreshes its model registry and this extension re-registers
the cached Portal catalog. Interactive sessions also refresh the Portal catalog
registration on `session_start`.

## Configuration

- `NOUS_API_KEY`: direct inference API key.
- `NOUS_PORTAL_BASE_URL`: defaults to `https://portal.nousresearch.com`.
- `NOUS_INFERENCE_BASE_URL`: defaults to `https://inference-api.nousresearch.com/v1`.
- `NOUS_CLIENT_ID`: defaults to `hermes-cli` because it doesn't accept anything else currently.
- `NOUS_MIN_KEY_TTL_SECONDS`: defaults to `1800`.

## Models

Nous Portal `/models` is the model allowlist. Matching OpenRouter `/models`
entries enrich that allowlist with context, pricing, image input, and reasoning
metadata. The static fallback catalog is registered when live discovery is
unavailable with usable credentials, and during unauthenticated startup/session
registration so Pi's API-key login provider discovery can list Nous. Pi filters
custom OAuth provider IDs out of the API-key picker, so this package uses the
internal `nous-portal-api-key` provider ID for the direct-key login entry while
displaying it as `Nous Research Portal`. Expired or invalid OAuth credentials
still keep the OAuth provider model list blank. See
[docs/models.md](docs/models.md).

## Testing

Run the offline unit tests with `npm test`. Live provider compatibility checks
are isolated behind `npm run test:compat` and skip unless the required Nous
model/API-key environment variables are set. See [docs/testing.md](docs/testing.md).
