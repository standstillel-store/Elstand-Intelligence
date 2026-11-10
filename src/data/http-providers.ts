import type { ProviderId } from '../core/provider-state.js';
import { ApiClientError, type ApiClient } from './api-client.js';
import {
  API_PROVIDERS_PATH,
  parseProvidersAnswer,
  type WireProbe,
  type WireProviderConfig,
} from './wire-providers.js';

/**
 * What the server says about its provider connections, and the one request a person can make to
 * check a provider for real. A check is never made by itself: the provider status page calls
 * `probe` only when its button is pressed, because a check spends a request of the provider's
 * allowance (one of Alpha Vantage's 25 a day, for example).
 */
export interface ProvidersAnswer {
  readonly providers: readonly WireProviderConfig[];
  /** The result of the check that was asked for, or null when none was. */
  readonly probe: WireProbe | null;
}

export interface ProvidersApi {
  list(signal: AbortSignal): Promise<ProvidersAnswer>;
  probe(provider: ProviderId, signal: AbortSignal): Promise<ProvidersAnswer>;
}

export function createProvidersApi(client: ApiClient): ProvidersApi {
  async function ask(params: Readonly<Record<string, string>>, signal: AbortSignal) {
    const body = await client.getJson(API_PROVIDERS_PATH, params, signal);
    const parsed = parseProvidersAnswer(body);
    if (parsed.ok === false) {
      throw new ApiClientError(
        'bad_response',
        `The API sent an unusable provider list: ${parsed.error}.`,
      );
    }
    return parsed.value;
  }
  return {
    list: (signal) => ask({}, signal),
    probe: (provider, signal) => ask({ probe: provider }, signal),
  };
}
