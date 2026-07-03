# 5-Minute Demonstration Script

Target: judges see all four journeys, the authentication model, the agent
handoff, and the architecture — in under five minutes.

## Before you start (not on the clock)

```bash
docker compose up -d          # postgres + backend + frontend + n8n
```

- Wait ~30s; confirm http://localhost:4000/health returns ok.
- Open tabs: **chat** http://localhost:3000, **n8n** http://localhost:5679,
  architecture diagram (docs/architecture-diagram.md rendered).
- `SEED_ON_START=true` (default) gives a fresh demo dataset on every boot:
  PNRs **BW9001/Doe**, **BW9002/Smith**, **BW9003/Kumar**.
- If demoing live WhatsApp: refresh the Meta temp access token, start
  `ngrok http 5679`, set the webhook to `https://<ngrok>/webhook/whatsapp`.

## Timeline

### 0:00 — Framing (30s)
> "BlueWings passengers manage bookings entirely in chat — WhatsApp or this
> installable PWA — instead of calling the contact centre. One conversational
> core serves both channels; n8n orchestrates WhatsApp; everything runs in
> Docker. Payments are simulated per the brief."

Show the PWA: WhatsApp-style UI, quick-reply chips, install prompt in the
address bar (PWA manifest + service worker).

### 0:30 — Flow 1: Check status + auth model (60s)
1. Type free text: **"what gate does my flight leave from? ref BW9001"**
   — point out the LLM extracted both the intent and the PNR.
2. Reply **Doe** → status card: flight, IST times, gate, seat, status.
3. Click **Download e-ticket** → branded PDF opens.
   > "Auth is PNR + last name, verified once per session — watch what that
   > means in a second."

### 1:30 — Flow 4: Cancel with no re-auth + refund (45s)
1. Type **"cancel BW9001"** — no last-name prompt (session already verified).
2. Yes/No chips appear → tap **No** first ("destructive actions need explicit
   confirmation"), then repeat with **BW9003 / Kumar** → **Yes**.
3. Full-fare simulated refund with transaction id.

### 2:15 — Flow 2: Book end-to-end (75s)
1. **"book a flight"** → origin **mumbai** (city names resolve to codes),
   destination **delhi**, a date ~3 days out.
2. Pick an option → name/email/phone → simulated payment → **new PNR + e-ticket**.
   > "All booking mutations are Prisma transactions — no partial writes."

### 3:30 — Flow 3 + escalation (45s)
1. **"reschedule my flight <new PNR>"** → new date → pick an alternative →
   RESCHEDULED + fresh e-ticket.
2. Type gibberish twice **or** "talk to a human" → agent-queue banner, simulated
   agent reply → type **menu** → instantly back with the bot.

### 4:15 — Under the hood (45s)
1. Flip to the n8n tab: show the WhatsApp workflow (webhook → translate →
   backend → Graph API reply) — "imported and activated automatically on boot".
2. Flip to the architecture diagram: channel-agnostic core, LLM with keyword
   fallback (an OpenRouter outage can't break a flow), session state in Postgres.
3. Close: **"22 integration tests, strict TypeScript, one `docker compose up`."**

## Fallbacks during the demo

| If… | Then… |
|---|---|
| Free-tier LLM rate-limits | The keyword router answers identically — say so, it's a feature |
| WhatsApp token expired | Demo the PWA only; show the n8n workflow canvas instead of a live message |
| A flow gets stuck mid-demo | Type `menu` — resets the session cleanly |
