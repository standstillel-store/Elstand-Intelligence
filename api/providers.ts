/// <reference types="node" />
import { handleProviders } from '../server/capability-handlers.js';

/** Vercel function entry. All logic lives in `server/capability-handlers.ts`. */
export default {
  fetch(request: Request): Promise<Response> {
    return handleProviders(request, { env: process.env, fetch: globalThis.fetch, now: Date.now });
  },
};
