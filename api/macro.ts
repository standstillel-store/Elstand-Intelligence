/// <reference types="node" />
import { handleMacro } from '../server/capability-handlers.js';

/** Vercel function entry. All logic lives in `server/capability-handlers.ts`. */
export default {
  fetch(request: Request): Promise<Response> {
    return handleMacro(request, { env: process.env, fetch: globalThis.fetch, now: Date.now });
  },
};
