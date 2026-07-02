# BlueWings Airlines — Conversational Booking & Servicing MVP

WhatsApp + PWA chat interface where passengers can **check booking status, book, reschedule, or cancel a flight** without calling an agent. Built for the **22North Product Engineering Challenge 2026**.

## The 4 flows (locked scope)

1. **Check booking status** — PNR + last name → status / gate / timing
2. **Book a new flight** — search → pick option → simulated payment → PNR
3. **Reschedule** — PNR → alternatives → confirm
4. **Cancel** — PNR → confirm → simulated refund (full fare)

**Authentication**: PNR + last name, verified **once per session** — servicing the
same PNR again (e.g. status check, then cancel) skips re-auth; a new booking marks
the session verified for its PNR.

**Agent handoff** (simulated queue) triggers on: explicit request, cancellation
disputes, or 2 consecutive failed intent parses. Typing `menu` (or tapping the
*Back to menu* chip) returns the user to the bot.

**CX**: the PWA renders backend-suggested **quick-reply chips** (menu options,
Yes/No confirmations), registers a **service worker** (installable, offline app
shell), and shows typing indicators in a WhatsApp-style UI.

## Tech stack

| Layer | Tech |
|---|---|
| Backend | Node.js + Express + TypeScript (strict), Prisma, PostgreSQL |
| Frontend | Next.js (PWA), WhatsApp-style chat UI, plain CSS |
| LLM | OpenRouter (configurable model list, zod-validated output, keyword fallback) |
| WhatsApp | Meta Cloud API, orchestrated by an **n8n workflow** |
| Infra | Docker Compose (postgres + backend + frontend + n8n) |

## Quick start (Docker — recommended)

```bash
cp .env.example .env        # fill in OPENROUTER_API_KEY (+ WhatsApp creds if used)
docker compose up -d --build
```

| Service | URL |
|---|---|
| Chat UI (PWA) | http://localhost:3000 |
| Backend API | http://localhost:4000 (health: `/health`) |
| n8n editor | http://localhost:5679 |
| Postgres | localhost:5433 (`postgres`/`postgres`, db `bluewings`) |

The backend container applies migrations and (with `SEED_ON_START=true`, the default) seeds ~96 mock flights and 5 bookings on boot. Try the chat with PNR **BW9001**, last name **Doe**.

## Local development (no Docker)

```bash
# backend — needs a local Postgres; set DATABASE_URL in backend/.env
cd backend && npm install
npx prisma migrate dev && npx prisma db seed
npm run dev                 # http://localhost:4000

# frontend (separate terminal)
cd frontend && npm install
npm run dev                 # http://localhost:3000 (proxies /api/* to :4000)
```

Or run both with `bash scripts/dev.sh`.

## Tests

```bash
cd backend && npm test      # 11 vitest integration tests over the 4 flows + handoff
```

Tests create their own fixtures, run against the configured database, and force the keyword intent router (offline-deterministic).

## Connecting real WhatsApp

1. Expose n8n publicly: `ngrok http 5679`, then set `N8N_PUBLIC_URL` in `.env` and `docker compose up -d n8n`.
2. In the Meta dashboard, set the webhook URL to `https://<ngrok>/webhook/whatsapp` with verify token `bluewings_verify_token_12345` (or your `WHATSAPP_VERIFY_TOKEN`).
3. Subscribe to the `messages` field. Inbound texts flow: **Meta → n8n → backend `/api/message` → n8n → Graph API reply**.

A direct Express webhook (`/api/webhook/whatsapp` on :4000) also exists as a no-n8n fallback.

## Repository layout

```
backend/    Express + Prisma API — services/ (business logic) vs adapters/ (format translation)
frontend/   Next.js PWA chat
n8n/        WhatsApp orchestration workflow (auto-imported on container start)
docs/       architecture diagram, API docs, DB schema
scripts/    local dev runner
```

See [docs/architecture-diagram.md](docs/architecture-diagram.md), [docs/api-documentation.md](docs/api-documentation.md), [docs/database-schema.md](docs/database-schema.md), [ASSUMPTIONS.md](ASSUMPTIONS.md), and [FUTURE_ENHANCEMENTS.md](FUTURE_ENHANCEMENTS.md).
