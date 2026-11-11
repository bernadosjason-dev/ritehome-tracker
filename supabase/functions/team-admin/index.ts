// Supabase Edge Function entry point. All the logic is in core.js (tested under Node).
import { makeHandler } from "./core.js";

Deno.serve(makeHandler({ env: Deno.env.toObject(), fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) }));
