# API Documentation

Base URL: `http://localhost:4000` (Docker) — the frontend proxies `/api/*` to it.

## GET /health

Liveness probe.

```json
{ "status": "ok", "service": "BlueWings Conversational Booking API" }
```

---

## POST /api/message

Channel-agnostic conversational entry point. Every user utterance — from the PWA
or from WhatsApp (via n8n / the adapter) — goes through this endpoint.

### Request

```json
{
  "channel": "PWA",          // "PWA" | "WHATSAPP"
  "userId": "any-stable-id", // browser uuid or WhatsApp phone number
  "message": "cancel my booking BW9003"
}
```

Validated with zod (`MessagePayloadSchema`). Invalid payloads → `400 {"error": ...}`.

### Response — `200`

```json
{
  "reply": "I found PNR *BW9003* in your request. Please enter the passenger's last name...",
  "sessionState": {
    "currentFlow": "CANCEL",   // CHECK_STATUS | BOOK | RESCHEDULE | CANCEL | null
    "step": 2,
    "slots": { "pnr": "BW9003" },
    "auth": { "verified": false },
    "consecutiveFailedParses": 0
  },
  "agentHandoff": false,
  "suggestions": ["Check status", "Book a flight", "Reschedule", "Cancel booking", "Talk to an agent"]
}
```

- `reply` uses WhatsApp text conventions (`*bold*`, emoji, newlines).
- `suggestions` are quick-reply chips for the current conversation point (menu
  options when idle, `Yes`/`No` at the cancel confirmation, `Back to menu` during
  handoff). The PWA renders them as tappable buttons; WhatsApp ignores them since
  the same options are numbered in the reply text.
- `sessionState.auth` persists a successful PNR + last-name verification for the
  rest of the session: starting another flow with the same PNR skips re-auth
  (e.g. `status BW9001` → verify once → `cancel BW9001` goes straight to the
  confirmation prompt). A different PNR requires verification again.
- `agentHandoff: true` means the session is parked in a simulated agent queue;
  subsequent messages get a simulated-agent holding reply. Typing `menu` (or
  `resume`) leaves the queue, resets the session, and returns to the bot.
- `ticketUrl` (optional) is a relative link to the PDF e-ticket, returned after a
  successful booking, reschedule, or status check of a non-cancelled booking. The
  PWA renders it as a download button; on WhatsApp the adapter appends a fully
  qualified download link to the reply text.
- `imageUrl` (optional) is a relative link to an illustrative image for the
  current step — set during **seat selection** (`/seat-map.png`). The PWA renders
  it inline in the chat bubble; WhatsApp shows the text seat list instead.

### Booking sub-flow: seat selection

After passenger details + phone, Book enters seat selection before payment:
the bot shows the seat map (rows 1–5 × A–F, occupied seats read live from other
bookings) and the list of available seats. The reply carries the seat labels as
`suggestions` and `imageUrl: "/seat-map.png"`. The chosen seat sets a price
adjustment (Premium rows 1–2: +₹800–1000; Standard rows 3–5: +₹0–300); the total
is charged via simulated payment and stored as `Booking.seatNumber` /
`Booking.pricePaid`. A declined payment (phone ending `0000`) keeps the selected
seat so the user only re-enters a payment number.

## GET /api/ticket/:pnr?lastName=<name>

Generates and streams the branded **PDF e-ticket** for a booking (route, times,
gate, seat, fare, barcode stub). Uses the same auth rule as the chat flows — the
`lastName` query parameter must match the passenger on the booking.

| Response | Meaning |
|---|---|
| `200` `application/pdf` | E-ticket streamed as an attachment (`BlueWings-E-Ticket-<PNR>.pdf`) |
| `400` | PNR not in `BW0000` format |
| `403` | Last name does not match the booking |
| `404` | No booking with that PNR |

```bash
curl -o ticket.pdf "http://localhost:4000/api/ticket/BW9001?lastName=Doe"
```
- Unexpected processing errors still return `200` with a friendly `reply`
  (the bot never goes silent); only payload validation returns `400`.

### Example conversations (curl)

```bash
# Flow 1 — check status
curl -X POST http://localhost:4000/api/message -H 'Content-Type: application/json' \
  -d '{"channel":"PWA","userId":"u1","message":"what gate is my flight? ref BW9001"}'
curl -X POST http://localhost:4000/api/message -H 'Content-Type: application/json' \
  -d '{"channel":"PWA","userId":"u1","message":"Doe"}'

# Flow 2 — book: book → BOM → DEL → 2026-07-08 → BW173 → name → email → phone
# Flow 3 — reschedule: reschedule BW9002 → Smith → 2026-07-06 → BW151
# Flow 4 — cancel: cancel BW9003 → Kumar → yes
```

---

## POST /api/ops/simulate-delay/:pnr

Ops/demo tool (no auth in the MVP): delays the flight behind a PNR and
proactively notifies affected passengers — an immediate WhatsApp push, plus a
notice that rides on top of their next chat reply on any channel.

```bash
curl -X POST http://localhost:4000/api/ops/simulate-delay/BW9001 \
  -H 'Content-Type: application/json' -d '{"minutes": 90}'
```

Response: `{ flight, delayedByMinutes, newDeparture, affectedBookings, whatsappPushes, sessionNotices }`.
`400` bad PNR format, `404` unknown PNR.

## Rate limiting

`/api/message` allows **30 requests/minute per IP**. Beyond that it returns
`429` with a friendly bot-style `reply` (the UI shows it like any message).

## WhatsApp webhooks

### Primary: n8n workflow — `http://localhost:5679/webhook/whatsapp`

| Method | Behaviour |
|---|---|
| `GET` | Meta verification: echoes `hub.challenge` when `hub.verify_token` matches `WHATSAPP_VERIFY_TOKEN`, else responds `Forbidden`. |
| `POST` | Acks `200` immediately, translates `entry[].changes[].value.messages[]`, calls `POST /api/message`, sends the reply via Graph API `POST /v20.0/{PHONE_NUMBER_ID}/messages`. |

Replies with `suggestions` become **native interactive messages**: reply
buttons for ≤3 chips, a list message for 4-10 (text fallback for long bodies).
Inbound button/list taps are translated back to their title text, so they route
through intent parsing exactly like typed messages. Both webhook paths (n8n and
Express) implement this identically.

### Fallback: Express adapter — `http://localhost:4000/api/webhook/whatsapp`

Same contract, implemented in `backend/src/adapters/whatsapp.adapter.ts` for
running without n8n. Non-text message types receive a canned "text only" reply.

---

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `OPENROUTER_API_KEY` | LLM intent parsing (empty → keyword router only) |
| `OPENROUTER_MODEL` | Model slug, or comma-separated fallback list (max 3) |
| `LLM_TIMEOUT_MS` | LLM request timeout (default 9000) |
| `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` | Graph API credentials |
| `WHATSAPP_VERIFY_TOKEN` | Webhook verification token |
| `SEED_ON_START` | Docker only: reseed demo data on boot |
| `N8N_PUBLIC_URL` | Public (ngrok) URL for n8n webhook registration |
