/// <reference types="node" />
import { handleCalendar } from '../server/capability-handlers.js';

/** Vercel function entry. All logic lives in `server/capability-handlers.ts`. */
export default {
  fetch(request: Request): Promise<Response> {
    return handleCalendar(request, { env: process.env, fetch: globalThis.fetch, now: Date.now });
  },
};
