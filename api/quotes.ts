import { handleQuotes } from '../server/handlers.js';

/** Vercel function entry. All logic lives in `server/handlers.ts`. */
export default {
  fetch(request: Request): Promise<Response> {
    return handleQuotes(request, { env: process.env, fetch: globalThis.fetch, now: Date.now });
  },
};
