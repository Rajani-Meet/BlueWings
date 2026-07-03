# AI Tools Used

Per the challenge's evaluation note — *"the evaluation is on engineering
decisions, product thinking, implementation quality & understanding, not on
writing every line of code manually"* — this document discloses where AI was
used in building and running BlueWings.

## 1. AI in the build process (development-time)

**Claude Code (Anthropic)** — used as an agentic pair-programmer throughout the
48-hour build: scaffolding, implementing the conversational state machine,
writing the Prisma layer and tests, wiring the WhatsApp/n8n integration,
containerisation, and documentation.

How it was used, and where the human decisions were:

- **Architecture was human-directed.** The channel-agnostic core, the
  services-vs-adapters split, the "LLM with deterministic keyword fallback"
  safety net, the n8n-orchestrated WhatsApp path, and the "verify once per
  session" auth model were product/engineering decisions we chose and the AI
  implemented. See [ASSUMPTIONS.md](../ASSUMPTIONS.md) and
  [architecture-diagram.md](architecture-diagram.md) for the rationale.
- **Every change was reviewed and verified.** Work proceeded in small,
  independently-tested steps (strict-TypeScript typecheck + a growing vitest
  suite + live end-to-end runs against the real database, WhatsApp Cloud API,
  and OpenRouter). Bugs the AI's first drafts introduced (e.g. an invalid Prisma
  `include`, an intent-router ordering bug) were caught by those tests and fixed.
- **Debugging was collaborative.** Getting real WhatsApp working required
  human-in-the-loop Meta dashboard steps (token refresh, app publish) plus an
  API-level fix (subscribing the app to the WABA) that the AI diagnosed from logs.

## 2. AI in the product (runtime)

**OpenRouter** (OpenAI-compatible gateway) is called at runtime for **natural-language
intent classification** in [`intentRouter.service.ts`](../backend/src/services/intentRouter.service.ts):

- Model: a configurable free-tier fallback list — `openai/gpt-oss-120b:free`,
  `nvidia/nemotron-3-super-120b-a12b:free`, `openai/gpt-oss-20b:free`
  (set via `OPENROUTER_MODEL`; provider/model swappable without touching calling code).
- Job: map a free-text message ("my flight got messed up, put me on a later one")
  to one of `CHECK_STATUS | BOOK | RESCHEDULE | CANCEL | MY_TRIPS | AGENT_HANDOFF`
  and extract slots (PNR, origin/destination, date). Also handles Hindi/Hinglish.
- **Safety net:** output is zod-validated; on timeout (9s), non-200, invalid JSON,
  or confidence < 0.55 the system falls back to a deterministic keyword router, so
  an LLM outage never breaks a flow. Mid-flow slot inputs skip the LLM entirely.

No AI is used for booking logic, payments, or data access — those are
deterministic, transactional, and fully tested.

## 3. Models referenced

| Where | Tool / model |
|---|---|
| Coding assistant | Claude Code (Anthropic) |
| Runtime intent parsing | OpenRouter → gpt-oss-120b / nemotron / gpt-oss-20b (free tier) |

## 4. Why this split

LLMs are excellent at understanding messy human phrasing and terrible as a
system of record. So we let the model do **only** the fuzzy front-of-funnel job
(intent + slots), gate its output behind schema validation and confidence
thresholds, and keep every state transition, mutation, and money-adjacent
operation in deterministic, tested code. That is the core engineering decision
behind the product.
