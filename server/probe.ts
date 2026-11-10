import { findInstrument } from '../src/core/instruments.js';
import { formatProviderTime, type ProviderId } from '../src/core/provider-state.js';
import type { Provenance } from '../src/data/provenance.js';
import type { AuthenticationResult, WireProbe } from '../src/data/wire-providers.js';
import { defaultCalendarDays, loadCalendar, loadNews, loadRates } from './feeds-service.js';
import { loadPrimaryQuote, loadSpotProbe } from './forex-service.js';
import { FRED_SERIES, WORLD_BANK_INDICATORS } from './macro-catalog.js';
import { loadBeaGroup, loadBlsGroup, loadFredSeries, loadWorldBankGroup } from './macro-service.js';
import { readProvider, type ProviderReading } from './provider-registry.js';
import { unreadyProvenance, type Outcome, type ServiceDeps } from './service.js';

/**
 * The connection check a person asks for on the provider page.
 *
 * A check is the provider's own normal request, asked through the same path as the module that
 * uses it, so it answers from that module's cache when the cache is fresh and spends nothing
 * extra. When the cache is empty it makes the one real request the module would have made, and
 * the module benefits from the answer. It is never run by itself: providers with a small daily
 * allowance (Alpha Vantage, Marketaux) are only asked when a person presses the button.
 *
 * What it reports is a fact about one moment: whether the provider answered, whether it accepted
 * the credential, and whether the data passed validation. "Configured" is not "verified".
 */

type Ready = Extract<ProviderReading, { readonly kind: 'ready' }>;

/** The request each provider is checked with. */
function requestFor(deps: ServiceDeps, id: ProviderId): Promise<Outcome<unknown>> {
  switch (id) {
    case 'twelvedata': {
      const pair = findInstrument('EURUSD');
      if (pair === undefined) throw new Error('The check pair EURUSD is not a known instrument.');
      return loadPrimaryQuote(deps, pair);
    }
    case 'alphavantage':
      return loadSpotProbe(deps);
    case 'fred': {
      const series = FRED_SERIES[0];
      if (series === undefined) throw new Error('The FRED catalog is empty.');
      return loadFredSeries(deps, series);
    }
    case 'financecalendar':
      return loadCalendar(deps, defaultCalendarDays(deps.now()));
    case 'marketaux':
      return loadNews(deps);
    case 'frankfurter':
      return loadRates(deps);
    case 'worldbank': {
      const indicator = WORLD_BANK_INDICATORS[0];
      if (indicator === undefined) throw new Error('The World Bank catalog is empty.');
      return loadWorldBankGroup(deps, indicator);
    }
    case 'bls':
      return loadBlsGroup(deps);
    case 'bea':
      return loadBeaGroup(deps);
    default:
      // IMF has no verified endpoint, so `readProvider` never reports it as ready.
      throw new Error(`Provider ${id} has no connection check.`);
  }
}

function authenticationOf(ready: Ready, outcome: Outcome<unknown>): AuthenticationResult {
  if (ready.spec.keyRequirement === 'none' || ready.apiKey === null) return 'not-required';
  if (outcome.kind === 'data') {
    // The last answer is older than the failed attempt that followed it: nothing was confirmed now.
    return outcome.provenance.cache === 'stale-if-error' ? 'unknown' : 'accepted';
  }
  return outcome.failure !== null && outcome.failure.code === 'provider_auth'
    ? 'rejected'
    : 'unknown';
}

function messageOf(provenance: Provenance, retrieved: boolean): string {
  if (provenance.message !== null) return provenance.message;
  if (retrieved && provenance.retrievedAt !== null) {
    return `${provenance.providerLabel} answered and its data passed validation. Retrieved ${formatProviderTime(provenance.retrievedAt)}.`;
  }
  return `${provenance.providerLabel} did not return data.`;
}

export async function probeProvider(deps: ServiceDeps, id: ProviderId): Promise<WireProbe> {
  const attemptedAt = deps.now();
  const reading = readProvider(id, deps.env);

  if (reading.kind !== 'ready') {
    const capability = reading.spec.capabilities[0];
    if (capability === undefined) throw new Error(`Provider ${id} lists no capability.`);
    const provenance = unreadyProvenance(id, capability, 'configuration', reading);
    return {
      provider: id,
      capability: provenance.capability,
      endpoint: provenance.endpoint,
      state: provenance.state,
      authentication: reading.spec.keyRequirement === 'none' ? 'not-required' : 'unknown',
      dataRetrieved: false,
      message: messageOf(provenance, false),
      attemptedAt,
      retrievedAt: null,
      dataAsOf: null,
    };
  }

  const outcome = await requestFor(deps, id);
  const retrieved = outcome.kind === 'data' && outcome.provenance.cache !== 'stale-if-error';
  return {
    provider: id,
    capability: outcome.provenance.capability,
    endpoint: outcome.provenance.endpoint,
    state: outcome.provenance.state,
    authentication: authenticationOf(reading, outcome),
    dataRetrieved: retrieved,
    message: messageOf(outcome.provenance, retrieved),
    attemptedAt,
    retrievedAt: outcome.provenance.retrievedAt,
    dataAsOf: outcome.provenance.dataAsOf,
  };
}
