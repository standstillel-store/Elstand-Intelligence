import {
  CAPABILITY_LABEL,
  NO_ENDPOINT_MESSAGE,
  PROVIDER_IDS,
  envNotConnectedMessage,
  type Capability,
  type ProviderId,
} from '../src/core/provider-state.js';
import type {
  KeyRequirement,
  ProviderRole,
  WireProviderConfig,
} from '../src/data/wire-providers.js';
import { ENV_API_KEY, isCredentialText, readBoundedInteger, type Env } from './env.js';
import type { BudgetSpec } from './limiter.js';
import { parseBaseUrl } from './provider-http.js';

/**
 * Every data provider Elstand knows about, in one table: what it supplies, which environment
 * variables it reads, what the free tier allows (as far as that has been verified), and what the
 * interface says when it is not connected.
 *
 * Three rules shape the table.
 *  - A variable existing is not a connection. `readProvider` says only whether a request MAY be
 *    sent (`ready`); whether it works is learned from a real request, never from this file.
 *  - A key is required only where the provider requires one. Public APIs run on their public
 *    address with no variable at all; a `*_BASE_URL` variable is an optional override.
 *  - Secrets leave this module only inside `ProviderReading.apiKey`, which handlers pass to the
 *    adapters. `describeProviders`, the only thing sent to the browser, carries names alone.
 */

export interface ProviderSpec {
  readonly id: ProviderId;
  readonly label: string;
  readonly capabilities: readonly Capability[];
  readonly role: ProviderRole;
  readonly roleText: string;
  readonly keyVariable: string | null;
  readonly keyRequirement: KeyRequirement;
  readonly baseUrlVariable: string | null;
  /** The provider's official public address, or null when none is used. */
  readonly defaultBaseUrl: string | null;
  /** What is lost when the credential is missing, for the ENV NOT CONNECTED message. */
  readonly consequence: string;
  /** The free-tier limits that were verified, in one sentence. */
  readonly limits: string;
}

export const ENV_ALPHA_VANTAGE_KEY = 'ALPHA_VANTAGE_API_KEY';
export const ENV_FRED_KEY = 'FRED_API_KEY';
export const ENV_FINANCE_CALENDAR_KEY = 'FINANCE_CALENDAR_API_KEY';
export const ENV_MARKETAUX_KEY = 'MARKETAUX_API_KEY';
export const ENV_FRANKFURTER_URL = 'FRANKFURTER_API_BASE_URL';
export const ENV_WORLD_BANK_URL = 'WORLD_BANK_API_BASE_URL';
export const ENV_IMF_URL = 'IMF_API_BASE_URL';
export const ENV_BLS_KEY = 'BLS_API_KEY';
export const ENV_BEA_KEY = 'BEA_API_KEY';
/** Optional overrides of the Twelve Data request budget, for a paid plan. Not secrets. */
export const ENV_TWELVE_DATA_PER_MINUTE = 'TWELVE_DATA_CREDITS_PER_MINUTE';
export const ENV_TWELVE_DATA_PER_DAY = 'TWELVE_DATA_CREDITS_PER_DAY';

export const TWELVE_DATA_BASE = 'https://api.twelvedata.com';
export const ALPHA_VANTAGE_BASE = 'https://www.alphavantage.co';
export const FRED_BASE = 'https://api.stlouisfed.org/fred';
export const FINANCE_CALENDAR_BASE = 'https://www.financecalendar.com/wp-json/fc/v1';
export const MARKETAUX_BASE = 'https://api.marketaux.com/v1';
export const FRANKFURTER_BASE = 'https://api.frankfurter.dev/v1';
export const WORLD_BANK_BASE = 'https://api.worldbank.org/v2';
export const BLS_BASE = 'https://api.bls.gov/publicAPI';
export const BEA_BASE = 'https://apps.bea.gov/api';

/** Where the owner of the data asks that its source is credited, for the dashboard and docs. */
export const FINANCE_CALENDAR_SITE = 'https://www.financecalendar.com';

export const PROVIDER_SPECS: Readonly<Record<ProviderId, ProviderSpec>> = {
  twelvedata: {
    id: 'twelvedata',
    label: 'Twelve Data',
    capabilities: ['forex-market-data'],
    role: 'primary',
    roleText: 'Primary source of forex quotes and candles.',
    keyVariable: ENV_API_KEY,
    keyRequirement: 'required',
    baseUrlVariable: null,
    defaultBaseUrl: TWELVE_DATA_BASE,
    consequence: 'Forex quotes and candles from Twelve Data are unavailable.',
    limits:
      'Basic plan: 8 API credits per minute and 800 per day. What the feed delivers (real-time or ' +
      'delayed) depends on the plan, and the plan’s terms govern public display of the data.',
  },
  alphavantage: {
    id: 'alphavantage',
    label: 'Alpha Vantage',
    capabilities: ['forex-market-data'],
    role: 'fallback',
    roleText:
      'Fallback for daily candles and spot quotes when Twelve Data cannot answer. Never used for ' +
      'intraday candles, and never for real-time claims.',
    keyVariable: ENV_ALPHA_VANTAGE_KEY,
    keyRequirement: 'required',
    baseUrlVariable: null,
    defaultBaseUrl: ALPHA_VANTAGE_BASE,
    consequence: 'The Alpha Vantage fallback for daily candles and spot quotes is unavailable.',
    limits:
      'Free key: 25 requests per day (official support page). Elstand also keeps to 5 per minute. ' +
      'Some forex endpoints are premium, so only the daily series and the spot rate are requested.',
  },
  fred: {
    id: 'fred',
    label: 'FRED',
    capabilities: ['macro-observations'],
    role: 'primary',
    roleText: 'Primary source of policy rates and inflation indices.',
    keyVariable: ENV_FRED_KEY,
    keyRequirement: 'required',
    baseUrlVariable: null,
    defaultBaseUrl: FRED_BASE,
    consequence: 'Macro observations from FRED are unavailable.',
    limits:
      'Free key. FRED rate-limits each key (a 429 is reported as RATE LIMITED); Elstand keeps to ' +
      '60 requests per minute and reads each series at most every 6 hours.',
  },
  financecalendar: {
    id: 'financecalendar',
    label: 'Finance Calendar',
    capabilities: ['economic-calendar'],
    role: 'primary',
    roleText: 'Primary source of the economic calendar.',
    keyVariable: ENV_FINANCE_CALENDAR_KEY,
    keyRequirement: 'optional',
    baseUrlVariable: null,
    defaultBaseUrl: FINANCE_CALENDAR_BASE,
    consequence: 'Economic calendar events from Finance Calendar are unavailable.',
    limits:
      'Without a key: 2,000 requests per day per IP address, which a host with shared outbound ' +
      'addresses may share with other sites. With a free key: 10,000 per day. Use requires a ' +
      'visible link to financecalendar.com wherever the data is shown.',
  },
  marketaux: {
    id: 'marketaux',
    label: 'Marketaux',
    capabilities: ['financial-news'],
    role: 'primary',
    roleText: 'Primary source of financial news headlines.',
    keyVariable: ENV_MARKETAUX_KEY,
    keyRequirement: 'required',
    baseUrlVariable: null,
    defaultBaseUrl: MARKETAUX_BASE,
    consequence: 'Financial news from Marketaux is unavailable.',
    limits:
      'Free plan: 100 requests per day and at most 3 articles per request. Elstand asks at most ' +
      'once per cache lifetime (30 minutes by default).',
  },
  frankfurter: {
    id: 'frankfurter',
    label: 'Frankfurter',
    capabilities: ['reference-rates'],
    role: 'reference',
    roleText:
      'Daily ECB reference rates. Reference data only: never a substitute for quotes or candles.',
    keyVariable: null,
    keyRequirement: 'none',
    baseUrlVariable: ENV_FRANKFURTER_URL,
    defaultBaseUrl: FRANKFURTER_BASE,
    consequence: 'Reference rates from Frankfurter are unavailable.',
    limits:
      'No key and no documented rate limit. Elstand keeps to 30 requests per minute. Rates are ' +
      'published once per ECB working day.',
  },
  worldbank: {
    id: 'worldbank',
    label: 'World Bank',
    capabilities: ['macro-observations'],
    role: 'reference',
    roleText: 'Annual GDP-growth and inflation indicators by country. Historical context only.',
    keyVariable: null,
    keyRequirement: 'none',
    baseUrlVariable: ENV_WORLD_BANK_URL,
    defaultBaseUrl: WORLD_BANK_BASE,
    consequence: 'Country indicators from the World Bank are unavailable.',
    limits:
      'No key and no documented rate limit. Elstand keeps to 30 requests per minute. Values are ' +
      'annual and arrive well after the year they describe.',
  },
  imf: {
    id: 'imf',
    label: 'IMF Data',
    capabilities: ['macro-observations'],
    role: 'unavailable',
    roleText:
      'No supported public endpoint has been verified, so no IMF dataset is requested. IMF data ' +
      'is not served through one uniform API.',
    keyVariable: null,
    keyRequirement: 'none',
    baseUrlVariable: ENV_IMF_URL,
    defaultBaseUrl: null,
    consequence: 'IMF datasets are unavailable.',
    limits: 'Not applicable: no IMF endpoint is used.',
  },
  bls: {
    id: 'bls',
    label: 'U.S. Bureau of Labor Statistics',
    capabilities: ['macro-observations'],
    role: 'primary',
    roleText: 'U.S. labor-market and consumer-price observations.',
    keyVariable: ENV_BLS_KEY,
    keyRequirement: 'optional',
    baseUrlVariable: null,
    defaultBaseUrl: BLS_BASE,
    consequence: 'U.S. labor-market observations from the BLS are unavailable.',
    limits:
      'Without a key (version 1): 25 queries per day. With a free registration key (version 2): ' +
      '500 queries per day. Both allow 50 requests per 10 seconds.',
  },
  bea: {
    id: 'bea',
    label: 'U.S. Bureau of Economic Analysis',
    capabilities: ['macro-observations'],
    role: 'primary',
    roleText: 'U.S. GDP growth from the national accounts.',
    keyVariable: ENV_BEA_KEY,
    keyRequirement: 'required',
    baseUrlVariable: null,
    defaultBaseUrl: BEA_BASE,
    consequence: 'U.S. GDP observations from the BEA are unavailable.',
    limits: 'Free key: 100 requests per minute, 100 MB per minute and 30 errors per minute.',
  },
};

/** The order providers are listed in, which is the order of the brief. */
export const PROVIDER_ORDER: readonly ProviderId[] = PROVIDER_IDS;

// ---- reading the environment ------------------------------------------------------------------------

/** FRED documents its keys as 32 lowercase letters and digits. */
const FRED_KEY = /^[a-z0-9]{32}$/;

export type ProviderReading =
  | {
      readonly kind: 'ready';
      readonly spec: ProviderSpec;
      /** The credential, or null when the provider is used without one. Never serialized. */
      readonly apiKey: string | null;
      readonly baseUrl: string;
    }
  | { readonly kind: 'env-missing'; readonly spec: ProviderSpec; readonly message: string }
  | { readonly kind: 'invalid'; readonly spec: ProviderSpec; readonly message: string }
  | { readonly kind: 'no-endpoint'; readonly spec: ProviderSpec; readonly message: string };

function readCredential(
  env: Env,
  variable: string,
): { readonly kind: 'absent' } | { readonly kind: 'bad' } | { readonly kind: 'key'; key: string } {
  const text = env[variable]?.trim() ?? '';
  if (text === '') return { kind: 'absent' };
  return isCredentialText(text) ? { kind: 'key', key: text } : { kind: 'bad' };
}

function invalidMessage(variable: string, label: string, detail: string): string {
  return `ERROR — ${variable} is set but ${detail}. The value is not shown and no request is sent to ${label}.`;
}

export function readProvider(id: ProviderId, env: Env): ProviderReading {
  const spec = PROVIDER_SPECS[id];

  if (spec.role === 'unavailable') {
    const variable = spec.baseUrlVariable;
    const set = variable !== null && (env[variable]?.trim() ?? '') !== '';
    return {
      kind: 'no-endpoint',
      spec,
      message: set
        ? `${NO_ENDPOINT_MESSAGE} ${variable} is set, but no IMF endpoint adapter exists, so it is not used.`
        : NO_ENDPOINT_MESSAGE,
    };
  }

  let apiKey: string | null = null;
  const keyVariable = spec.keyVariable;
  if (keyVariable !== null) {
    const credential = readCredential(env, keyVariable);
    if (credential.kind === 'bad') {
      return {
        kind: 'invalid',
        spec,
        message: invalidMessage(
          keyVariable,
          spec.label,
          'does not look like a credential (it must be one token with no spaces, quotes or angle brackets)',
        ),
      };
    }
    if (credential.kind === 'key') {
      if (id === 'fred' && !FRED_KEY.test(credential.key)) {
        return {
          kind: 'invalid',
          spec,
          message: invalidMessage(
            keyVariable,
            spec.label,
            'is not a 32-character lowercase FRED key',
          ),
        };
      }
      apiKey = credential.key;
    } else if (spec.keyRequirement === 'required') {
      return {
        kind: 'env-missing',
        spec,
        message: envNotConnectedMessage(keyVariable, spec.consequence),
      };
    }
  }

  let baseUrl = spec.defaultBaseUrl ?? '';
  const urlVariable = spec.baseUrlVariable;
  if (urlVariable !== null) {
    const override = env[urlVariable]?.trim() ?? '';
    if (override !== '') {
      const parsed = parseBaseUrl(override);
      if (parsed === null) {
        return {
          kind: 'invalid',
          spec,
          message: invalidMessage(
            urlVariable,
            spec.label,
            'is not a valid https address (no credentials, query or fragment)',
          ),
        };
      }
      baseUrl = parsed;
    }
  }
  return { kind: 'ready', spec, apiKey, baseUrl };
}

export function readAllProviders(env: Env): Readonly<Record<ProviderId, ProviderReading>> {
  const entries = PROVIDER_ORDER.map((id) => [id, readProvider(id, env)] as const);
  return Object.fromEntries(entries) as Record<ProviderId, ProviderReading>;
}

/** The message that explains why a provider cannot be asked, or null when it can be. */
export function unreadyMessage(reading: ProviderReading): string | null {
  return reading.kind === 'ready' ? null : reading.message;
}

// ---- budgets ------------------------------------------------------------------------------------------

const MAX_PER_MINUTE = 10_000;
const MAX_PER_DAY = 10_000_000;

/**
 * What Elstand may spend per provider. Budgets are deliberately below the published limits, so
 * that a request that would be refused is never sent. They are counted per server instance.
 */
export function budgetFor(id: ProviderId, env: Env, keyed: boolean): BudgetSpec {
  switch (id) {
    case 'twelvedata':
      return {
        perMinute: readBoundedInteger(env[ENV_TWELVE_DATA_PER_MINUTE], 8, 1, MAX_PER_MINUTE),
        perDay: readBoundedInteger(env[ENV_TWELVE_DATA_PER_DAY], 800, 1, MAX_PER_DAY),
      };
    case 'alphavantage':
      return { perMinute: 5, perDay: 25 };
    case 'fred':
      return { perMinute: 60, perDay: null };
    case 'financecalendar':
      return keyed ? { perMinute: 30, perDay: 9_000 } : { perMinute: 20, perDay: 1_500 };
    case 'marketaux':
      return { perMinute: 3, perDay: 90 };
    case 'frankfurter':
    case 'worldbank':
      return { perMinute: 30, perDay: null };
    case 'bls':
      return keyed ? { perMinute: 20, perDay: 400 } : { perMinute: 5, perDay: 20 };
    case 'bea':
      return { perMinute: 30, perDay: null };
    case 'imf':
      return { perMinute: 0, perDay: 0 };
  }
}

// ---- what the browser is told ---------------------------------------------------------------------

function configStateOf(reading: ProviderReading): WireProviderConfig['config'] {
  switch (reading.kind) {
    case 'ready':
      return 'ready';
    case 'env-missing':
      return 'env-not-connected';
    case 'invalid':
      return 'invalid';
    case 'no-endpoint':
      return 'no-endpoint';
  }
}

/** Names and states only. No credential, and no address that could carry one, leaves the server. */
export function describeProviders(env: Env): WireProviderConfig[] {
  return PROVIDER_ORDER.map((id) => {
    const reading = readProvider(id, env);
    const { spec } = reading;
    return {
      id,
      label: spec.label,
      capabilities: spec.capabilities,
      role: spec.role,
      roleText: spec.roleText,
      keyVariable: spec.keyVariable,
      keyRequirement: spec.keyRequirement,
      baseUrlVariable: spec.baseUrlVariable,
      config: configStateOf(reading),
      keyed: reading.kind === 'ready' && reading.apiKey !== null,
      message: unreadyMessage(reading),
      limits: spec.limits,
    };
  });
}

/** The providers that can supply a capability, in table order. */
export function providersFor(capability: Capability): readonly ProviderSpec[] {
  return PROVIDER_ORDER.map((id) => PROVIDER_SPECS[id]).filter((spec) =>
    spec.capabilities.includes(capability),
  );
}

export function capabilityName(capability: Capability): string {
  return CAPABILITY_LABEL[capability];
}
