/// <reference types="node" />
import { handleRates } from '../server/capability-handlers.js';

/** Vercel function entry. All logic lives in `server/capability-handlers.ts`. */
export default {
  fetch(request: Request): Promise<Response> {
    return handleRates(request, { env: process.env, fetch: globalThis.fetch, now: Date.now });
  },
};
