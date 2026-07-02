# Assumptions — BlueWings Airlines MVP

Product and technical assumptions made while implementing the MVP. Each was chosen
to keep the locked 4-flow scope shippable without waiting on clarification.

## Product

1. **PNR format** — `BW` + 4 digits (e.g. `BW9001`). Case-insensitive on input.
2. **Auth = PNR + last name.** Matching the passenger's last name against the
   booking is sufficient identity verification for the MVP. No OTP/SMS is sent
   (the brief's "mock OTP" is realized as this lighter check; real OTP is listed
   in FUTURE_ENHANCEMENTS).
3. **Payments always succeed.** `payment.service` returns success with a generated
   transaction ID. Refunds are a fixed simulated amount (Rs. 4500) with a fake
   transaction reference — no fare rules or cancellation fees.
4. **Gate assignment is simulated** deterministically from the PNR (stable per
   booking), since mock flights have no real gate data.
5. **One active conversation per (channel, user).** A new intent mid-flow doesn't
   interrupt the current flow; users complete or abandon a flow (or type 'agent').
6. **Agent handoff is UI state only** — a flag + holding message. No queue,
   routing, or human console. Handoff triggers: explicit request ("agent",
   "human", ...), cancellation-dispute keywords at the cancel-confirm step
   ("fee", "dispute", "unfair", ...), or 2 consecutive failed intent parses.
7. **Dates are IST-rendered** (`Asia/Kolkata`) since BlueWings routes are Indian
   domestic (BOM/DEL/BLR). Travel dates are entered as `YYYY-MM-DD`.
8. **Reschedule keeps the same route** (origin/destination of the original
   booking); only date/flight change. Price differences are not charged.

## Technical

9. **LLM is optional at runtime.** With no `OPENROUTER_API_KEY`, or on any LLM
   failure (timeout, non-200, invalid JSON, zod rejection, confidence < 0.55),
   the deterministic keyword router handles intent. Free-tier OpenRouter models
   rate-limit sporadically, so `OPENROUTER_MODEL` accepts a fallback list
   (max 3, OpenRouter limit) tried server-side in one request.
10. **Mid-flow messages skip the LLM.** Once a flow is active, inputs are slot
    values ("BOM", "Doe", "yes") consumed by the state machine; only the
    keyword-detectable 'agent' escape hatch is honored. Saves latency and quota.
11. **n8n is the primary WhatsApp path** (per the pivot to an n8n-based
    architecture); the Express adapter webhook remains as a fallback so the
    system runs without n8n. Both call the same channel-agnostic core.
12. **n8n workflow credentials come from container env vars** (`$env` in
    expressions, `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`) rather than n8n's
    credential store, so the workflow imports cleanly with zero manual setup.
13. **Docker port remapping**: Postgres on host `5433` and n8n on host `5679`,
    because the dev machine already runs a local PostgreSQL on 5432 and another
    n8n on 5678. Inside the compose network, standard ports are used.
14. **WhatsApp replies are plain text.** Interactive buttons/lists are a future
    enhancement; numbered options in text keep PWA and WhatsApp behavior identical.
15. **Tests hit a real Postgres** (self-contained fixtures, cleaned up per run)
    rather than mocking Prisma — the flows' value is in the DB transitions.
16. **Session state trusts the database, not the client.** The `sessionState`
    field in responses is informational; the server always reloads state from
    `ConversationSession`.
