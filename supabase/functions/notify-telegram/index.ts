// Supabase Edge Function entry point. All the logic is in core.js (tested under Node).
import { makeNotifier } from "./core.js";

Deno.serve(makeNotifier({ env: Deno.env.toObject(), fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) }));
