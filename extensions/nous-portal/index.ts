import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
	PROVIDER_ID,
	PROVIDER_NAME,
	applyStoredModelCatalog,
	buildFallbackModels,
	fetchModelCatalog,
	getInferenceBaseUrl,
} from "./models.ts";
import {
	getNousPortalApiKey,
	loginNousPortal,
	refreshNousPortalCredentials,
} from "./auth.ts";

async function startupModels() {
	const inferenceBaseUrl = getInferenceBaseUrl();
	const fallback = buildFallbackModels(inferenceBaseUrl);
	const apiKey = process.env.NOUS_API_KEY?.trim();
	if (!apiKey) return fallback;
	try {
		const liveModels = await fetchModelCatalog(apiKey, inferenceBaseUrl, {
			timeoutMs: DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS,
		});
		return liveModels.length > 0 ? liveModels : fallback;
	} catch {
		return fallback;
	}
}

export default async function nousPortalProvider(pi: ExtensionAPI) {
	const baseUrl = getInferenceBaseUrl();
	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl,
		apiKey: "NOUS_API_KEY",
		api: "openai-completions",
		models: await startupModels(),
		oauth: {
			name: PROVIDER_NAME,
			login: loginNousPortal,
			refreshToken: refreshNousPortalCredentials,
			getApiKey: getNousPortalApiKey,
			modifyModels: applyStoredModelCatalog,
		},
	});
}

export {
	PROVIDER_ID,
	PROVIDER_NAME,
	applyStoredModelCatalog as modifyNousPortalModels,
	fetchModelCatalog,
	loginNousPortal,
	refreshNousPortalCredentials,
};
