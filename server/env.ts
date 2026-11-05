import type { SourceMode } from '../src/core/types.js';

/**
 * Server environment. Nothing here is required for the application to start: with no
 * credentials the API reports `connected: false` and the interface shows ENV NOT CONNECTION.
 * Secrets stay on the server and are never returned by any endpoint, including `/api/status`
 * (which lists only the NAMES of missing variables).
 */

/** Twelve Data API key. Secret. */
export const ENV_API_KEY = 'TWELVE_DATA_API_KEY';
/** Set to `true` only if your provider plan delivers real-time forex. Otherwise data is labelled DELAYED. */
export const ENV_REALTIME = 'ELSTAND_FEED_REALTIME';
/** Seconds between provider refreshes (server cache lifetime and browser poll cadence). */
export const ENV_REFRESH = 'ELSTAND_REFRESH_SECONDS';

export const DEFAULT_REFRESH_SECONDS = 60;
export const MIN_REFRESH_SECONDS = 10;
export const MAX_REFRESH_SECONDS = 3_600;

/** How old a datum may be before it is labelled STALE. Declared per mode, never guessed in the UI. */
export const STALE_AFTER_MS: Readonly<Record<SourceMode, number>> = {
  live: 5 * 60_000,
  delayed: 30 * 60_000,
};

/** The environment, as the handlers receive it. */
export type Env = Readonly<Record<string, string | undefined>>;

export interface ServerConfig {
  readonly apiKey: string;
  readonly mode: SourceMode;
  readonly staleAfterMs: number;
  readonly refreshSeconds: number;
}

export type EnvReading =
  | { readonly connected: true; readonly config: ServerConfig }
  | { readonly connected: false; readonly missing: readonly string[] };

/**
 * Only a plain run of digits counts. Anything else (unset, blank, `abc`, `1.5`, `-5`, `1e2`,
 * `0x10`) is a misconfiguration and falls back to the default rather than being guessed at; a
 * valid number outside the allowed range is clamped to it.
 */
function readRefreshSeconds(raw: string | undefined): number {
  return readBoundedInteger(raw, DEFAULT_REFRESH_SECONDS, MIN_REFRESH_SECONDS, MAX_REFRESH_SECONDS);
}

/**
 * A whole number from the environment (seconds, credits), clamped to `min`..`max`. Anything that
 * is not a plain run of digits (unset, blank, `abc`, `1.5`, `1e2`, `0x10`) gives `fallback`.
 */
export function readBoundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const text = raw?.trim() ?? '';
  if (!/^\d+$/.test(text)) return fallback;
  return Math.min(max, Math.max(min, Number(text)));
}

/** The refresh cadence on its own, for code that runs without a Twelve Data key. */
export function readRefreshCadence(env: Readonly<Record<string, string | undefined>>): number {
  return readRefreshSeconds(env[ENV_REFRESH]);
}

/**
 * A credential is one visible token: no space, no control character, no quote (a value pasted
 * from a `.env` file keeps its quotes) and no angle bracket (an unfilled `<placeholder>`). A value
 * with one is a paste error, and sending it would only corrupt the header or query string it
 * travels in and be refused by the provider.
 */
const CREDENTIAL = /^[\x21\x23-\x26\x28-\x3b\x3d\x3f-\x7e]{1,200}$/;

export function isCredentialText(text: string): boolean {
  return CREDENTIAL.test(text);
}

export function readServerConfig(env: Readonly<Record<string, string | undefined>>): EnvReading {
  const apiKey = env[ENV_API_KEY]?.trim() ?? '';
  // A key that is blank, or is not one clean token, cannot be sent: it is reported as not set.
  // The provider dashboard tells the two cases apart (`readProvider`).
  if (apiKey === '' || !isCredentialText(apiKey)) {
    return { connected: false, missing: [ENV_API_KEY] };
  }
  const mode: SourceMode = env[ENV_REALTIME]?.trim().toLowerCase() === 'true' ? 'live' : 'delayed';
  return {
    connected: true,
    config: {
      apiKey,
      mode,
      staleAfterMs: STALE_AFTER_MS[mode],
      refreshSeconds: readRefreshSeconds(env[ENV_REFRESH]),
    },
  };
}
