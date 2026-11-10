import {
  isCapability,
  isProviderId,
  isProviderState,
  type Capability,
  type ProviderId,
  type ProviderState,
} from '../core/provider-state.js';
import { parseProvenance, type Provenance } from './provenance.js';
import type { Parsed, WireCandles, WireQuotes, WireStatus } from './wire.js';

/**
 * What the server says about its provider connections: which variables each provider reads
 * (names only), whether they are set, and, when a user asks for it, what a real request to the
 * provider just did.
 *
 * `/api/providers` is configuration, not verification. A provider whose variable is set is
 * `ready`, which only means a request may be sent. It becomes LIVE, DELAYED, CACHED or CALCULATED
 * only when a request has been answered and validated, and the data endpoints say so in their
 * own `provenance`. Nothing here ever contains a credential.
 */

export const API_PROVIDERS_PATH = '/api/providers';

export const KEY_REQUIREMENTS = ['required', 'optional', 'none'] as const;
export type KeyRequirement = (typeof KEY_REQUIREMENTS)[number];

export const PROVIDER_ROLES = ['primary', 'fallback', 'reference', 'unavailable'] as const;
export type ProviderRole = (typeof PROVIDER_ROLES)[number];

/**
 *  - `ready`: nothing is missing, so a request may be sent. Not a claim that it will succeed.
 *  - `env-not-connected`: a variable this provider needs is not set.
 *  - `invalid`: a variable is set but its value cannot be used (never shown).
 *  - `no-endpoint`: no verified endpoint exists in this build, whatever the environment says.
 */
export const CONFIG_STATES = ['ready', 'env-not-connected', 'invalid', 'no-endpoint'] as const;
export type ConfigState = (typeof CONFIG_STATES)[number];

export interface WireProviderConfig {
  readonly id: ProviderId;
  readonly label: string;
  readonly capabilities: readonly Capability[];
  readonly role: ProviderRole;
  /** The role in plain words, e.g. "Primary source of macro observations". */
  readonly roleText: string;
  /** The NAME of the credential variable, or null when the provider has none. */
  readonly keyVariable: string | null;
  readonly keyRequirement: KeyRequirement;
  /** The NAME of the variable that overrides the provider's public address, if it has one. */
  readonly baseUrlVariable: string | null;
  readonly config: ConfigState;
  /** True when a credential is set and used. False for keyless use of a provider with an optional key. */
  readonly keyed: boolean;
  /** The words to show when `config` is not `ready`. */
  readonly message: string | null;
  /** The limits that were verified for the provider's free tier, in one sentence. */
  readonly limits: string;
}

export interface WireProviders {
  readonly providers: readonly WireProviderConfig[];
}

/**
 * What `/api/status` sends: the established status fields plus the provider configuration. The
 * established parser (`parseStatus`) ignores the addition; `parseProviders` reads it.
 */
export type WireStatusBody = WireStatus & WireProviders;

/** `/api/quotes` with the provenance of each quote: which provider answered, and in which state. */
export type WireQuotesAnswer = WireQuotes & {
  readonly provenance: Readonly<Record<string, Provenance>>;
};

/** `/api/candles` with the provenance of the series. */
export type WireCandlesAnswer = WireCandles & { readonly provenance: Provenance };

/** `/api/providers`: the configuration, and the result of a probe when one was asked for. */
export interface WireProvidersAnswer extends WireProviders {
  readonly probe?: WireProbe;
}

export const AUTHENTICATION_RESULTS = [
  /** The provider accepted the credential that was sent. */
  'accepted',
  /** The provider rejected it. */
  'rejected',
  /** The provider needs no credential, or none was sent. */
  'not-required',
  /** The request failed before the provider could say. */
  'unknown',
] as const;
export type AuthenticationResult = (typeof AUTHENTICATION_RESULTS)[number];

/** What a user-initiated request to one provider found. A fact about one moment, not a status. */
export interface WireProbe {
  readonly provider: ProviderId;
  /**
   * The one capability the check exercised. A check is one real request, so it says nothing about
   * a provider's other capabilities, and the provider page never applies it to them.
   */
  readonly capability: Capability;
  /** The endpoint the request went to, as the data responses name it. */
  readonly endpoint: string;
  readonly state: ProviderState;
  readonly authentication: AuthenticationResult;
  /** True only when the answer parsed and passed validation. */
  readonly dataRetrieved: boolean;
  readonly message: string;
  /** When the server made the request (epoch ms). */
  readonly attemptedAt: number;
  /** When the provider last answered with valid data, if it ever did (epoch ms). */
  readonly retrievedAt: number | null;
  /** The data's own timestamp, when it has one (epoch ms). */
  readonly dataAsOf: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const isNullableText = (value: unknown): value is string | null => value === null || isText(value);

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function oneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

function parseProviderConfig(input: unknown): Parsed<WireProviderConfig> {
  const bad = (reason: string): Parsed<WireProviderConfig> => ({ ok: false, error: reason });
  if (!isRecord(input)) return bad('a provider entry is not an object');
  const { id, label, capabilities, role, roleText, keyVariable, keyRequirement } = input;
  const { baseUrlVariable, config, keyed, message, limits } = input;
  if (!isProviderId(id)) return bad('a provider entry has an unknown id');
  if (!isText(label) || !isText(roleText) || !isText(limits)) {
    return bad(`provider ${id} is missing its label, role or limits`);
  }
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return bad(`provider ${id} lists no capabilities`);
  }
  const checked: Capability[] = [];
  for (const capability of capabilities as unknown[]) {
    if (!isCapability(capability)) return bad(`provider ${id} lists an unknown capability`);
    checked.push(capability);
  }
  if (!oneOf(PROVIDER_ROLES, role)) return bad(`provider ${id} has an unknown role`);
  if (!oneOf(KEY_REQUIREMENTS, keyRequirement)) {
    return bad(`provider ${id} has an unknown key requirement`);
  }
  if (!isNullableText(keyVariable) || !isNullableText(baseUrlVariable)) {
    return bad(`provider ${id} has a malformed variable name`);
  }
  if (!oneOf(CONFIG_STATES, config)) return bad(`provider ${id} has an unknown configuration`);
  if (typeof keyed !== 'boolean') return bad(`provider ${id} does not say whether it is keyed`);
  if (!isNullableText(message)) return bad(`provider ${id} has a malformed message`);
  if (config !== 'ready' && message === null) {
    return bad(`provider ${id} is not ready but gives no reason`);
  }
  return {
    ok: true,
    value: {
      id,
      label,
      capabilities: checked,
      role,
      roleText,
      keyVariable,
      keyRequirement,
      baseUrlVariable,
      config,
      keyed,
      message,
      limits,
    },
  };
}

export function parseProviders(input: unknown): Parsed<WireProviders> {
  if (!isRecord(input) || !Array.isArray(input['providers'])) {
    return { ok: false, error: 'the provider list is malformed' };
  }
  const providers: WireProviderConfig[] = [];
  const seen = new Set<string>();
  for (const raw of input['providers'] as unknown[]) {
    const parsed = parseProviderConfig(raw);
    if (parsed.ok === false) return { ok: false, error: parsed.error };
    if (seen.has(parsed.value.id)) {
      return { ok: false, error: `provider ${parsed.value.id} is listed twice` };
    }
    seen.add(parsed.value.id);
    providers.push(parsed.value);
  }
  return { ok: true, value: { providers } };
}

export function parseProbe(input: unknown): Parsed<WireProbe> {
  const bad = (reason: string): Parsed<WireProbe> => ({ ok: false, error: reason });
  if (!isRecord(input)) return bad('the probe result is not an object');
  const { provider, state, authentication, dataRetrieved, message, attemptedAt } = input;
  const { retrievedAt, dataAsOf, capability, endpoint } = input;
  if (!isProviderId(provider)) return bad('the probe names an unknown provider');
  if (!isCapability(capability)) return bad('the probe names an unknown capability');
  if (!isText(endpoint)) return bad('the probe does not name its endpoint');
  if (!isProviderState(state)) return bad('the probe has an unknown state');
  if (!oneOf(AUTHENTICATION_RESULTS, authentication)) {
    return bad('the probe has an unknown authentication result');
  }
  if (typeof dataRetrieved !== 'boolean')
    return bad('the probe does not say if data was retrieved');
  if (!isText(message)) return bad('the probe has no message');
  if (!isTime(attemptedAt)) return bad('the probe has no attempt time');
  if ((retrievedAt !== null && !isTime(retrievedAt)) || (dataAsOf !== null && !isTime(dataAsOf))) {
    return bad('the probe has a malformed time');
  }
  return {
    ok: true,
    value: {
      provider,
      capability,
      endpoint,
      state,
      authentication,
      dataRetrieved,
      message,
      attemptedAt,
      retrievedAt: retrievedAt as number | null,
      dataAsOf: dataAsOf as number | null,
    },
  };
}

/** The configuration, and the probe result when the request asked for one. */
export function parseProvidersAnswer(
  input: unknown,
): Parsed<{ readonly providers: readonly WireProviderConfig[]; readonly probe: WireProbe | null }> {
  const providers = parseProviders(input);
  if (providers.ok === false) return { ok: false, error: providers.error };
  const raw = isRecord(input) ? input['probe'] : undefined;
  if (raw === undefined || raw === null) {
    return { ok: true, value: { providers: providers.value.providers, probe: null } };
  }
  const probe = parseProbe(raw);
  if (probe.ok === false) return { ok: false, error: probe.error };
  return { ok: true, value: { providers: providers.value.providers, probe: probe.value } };
}

/**
 * The provenance the server attached to each quote, by instrument id. It is metadata, so a
 * response without it, or with an entry that does not validate, still yields its quotes: the
 * entries that do validate are returned and the rest are left out.
 */
export function parseQuotesProvenance(input: unknown): Readonly<Record<string, Provenance>> {
  const found: Record<string, Provenance> = {};
  const raw = isRecord(input) ? input['provenance'] : undefined;
  if (!isRecord(raw)) return found;
  for (const [id, entry] of Object.entries(raw)) {
    const parsed = parseProvenance(entry);
    if (parsed.kind === 'parsed') found[id] = parsed.value;
  }
  return found;
}

/** The provenance of a candle series, or null when the response carries none that validates. */
export function parseCandlesProvenance(input: unknown): Provenance | null {
  const raw = isRecord(input) ? input['provenance'] : undefined;
  if (raw === undefined) return null;
  const parsed = parseProvenance(raw);
  return parsed.kind === 'parsed' ? parsed.value : null;
}
