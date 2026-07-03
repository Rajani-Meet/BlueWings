# BlueWings — Presentation Deck

Slide-by-slide content for the submission deck. Each slide is deliberately one
idea. Speaker notes in _italics_. Paste into PowerPoint/Google Slides, or present
this file directly. Mapped to the judging criteria (weight in brackets).

---

## Slide 1 — Title

# BlueWings Airlines
### Conversational Booking & Servicing on WhatsApp + PWA
Challenge 2 · Global Airline · 48-hour MVP

_One-liner: "Passengers complete booking and servicing journeys in a chat —
no contact-centre call."_

---

## Slide 2 — The problem & who we built for  · _Business Understanding (15%)_

- Contact centres are expensive and slow for routine servicing.
- Most passenger needs are **self-service-able**: status, book, reschedule, cancel.
- Our users are on **WhatsApp** (India-domestic: BOM/DEL/BLR…) and expect
  instant, thumb-friendly answers.
- **Goal:** deflect routine journeys to chat; escalate to a human only when it
  actually adds value.

---

## Slide 3 — Journeys we chose (and why)  · _Product Thinking (20%)_

Supported, because they cover the bulk of contact-centre volume and each has a
clear "done":

1. **Check status** — PNR + last name → flight, gate, seat, timing, e-ticket
2. **Book** — search → seat select → simulated pay → PNR + PDF ticket
3. **Reschedule** — PNR → alternatives → confirm
4. **Cancel** — PNR → confirm → simulated refund

_Deliberately out of MVP scope: loyalty, multi-city, real payments — logged in
FUTURE_ENHANCEMENTS so scope stays honest._

---

## Slide 4 — Authentication: light but safe  · _Security (15%)_

- **PNR + last name**, verified **once per session** — servicing the same PNR
  again (status → cancel) never re-asks. A different PNR re-verifies.
- No OTP/SMS friction for an MVP; e-ticket links re-check the last name so a
  leaked PNR alone can't fetch a ticket.
- Session identity lives server-side in Postgres, never trusted from the client.

_Design decision: match the sensitivity of the action to the friction of the
check — and never make a verified user prove themselves twice in one session._

---

## Slide 5 — When we involve an agent  · _Product Thinking (20%)_

Handoff (a simulated queue in the MVP) triggers on:
- **Explicit** request ("talk to a human")
- **Cancellation disputes** (fee/unfair/refund-amount at the confirm step)
- **2 consecutive failed intent parses** (the bot admits it's stuck)

And you're never trapped — typing **menu** returns you to the bot instantly.

_We escalate on frustration and ambiguity, not on every unknown word._

---

## Slide 6 — Live demo  · _Working Product (30%) + Demonstration (10%)_

_(≈2.5 min — see docs/demo-script.md)_
1. WhatsApp: "what gate am I leaving from? BW9001" → LLM gets intent **and** PNR
2. "cancel BW9001" → **no re-auth** (verified) → **Yes/No buttons**
3. "book mumbai to delhi on <date>" → **one message** → options → **seat map** →
   pay → **PNR + PDF e-ticket**
4. Gibberish ×2 → agent queue → **menu** → back with the bot

_Same bot answers on the PWA — installable, offline app shell, typing indicators._

---

## Slide 7 — Architecture  · _Solution Design (15%)_

```
WhatsApp ──▶ n8n workflow ─┐
PWA chat  ──▶ Next proxy  ─┼─▶  /api/message  (channel-agnostic core)
                           │      intent (LLM │ keyword) → state machine → services
                           └────▶  Prisma  ──▶  PostgreSQL
```
- **One brain, many channels.** Adapters only translate formats; all logic lives
  behind `processIncomingMessage()`.
- **n8n** orchestrates WhatsApp as an editable visual workflow.
- Everything is one `docker compose up`.

_(Full diagram + sequence: docs/architecture-diagram.md)_

---

## Slide 8 — The key engineering decision  · _Engineering Quality (10%)_

**LLM for understanding, deterministic code for truth.**

- OpenRouter LLM does only intent + slot extraction (incl. Hindi/Hinglish).
- Output is **zod-validated + confidence-gated**; on any failure it falls back to
  a keyword router. **An LLM outage cannot break a flow.**
- Every booking mutation is a **Prisma `$transaction`** — no partial writes.

_This is what makes an LLM safe to put in front of money-adjacent operations._

---

## Slide 9 — Non-functionals  · _Scalability / Performance / Deployment (15%)_

- **Stateless backend** (session state in Postgres) → horizontally scalable.
- **Rate limiting** 30/min/IP with a friendly reply.
- **Resilience:** LLM timeout + fallback; webhook acks Meta in ~3ms then works
  async; the bot never goes silent (even errors return a friendly message).
- **Deploy:** Dockerised; Render blueprint (`render.yaml`) + Vercel for the PWA
  (docs/deployment.md).

---

## Slide 10 — Engineering quality  · _Engineering Quality (10%)_

- **Strict TypeScript**, services/adapters separation.
- **36 integration tests** through the real core + DB (all 4 flows, auth,
  handoff, payment-decline retry, one-message booking, delay notices, Hinglish).
- **GitHub Actions CI** — Postgres service, typecheck, full suite on every push.
- **Docs:** README, architecture, API, DB schema, assumptions, customer journey,
  deployment, AI-tools disclosure.

---

## Slide 11 — Innovation highlights  · _Innovation (20%)_

- **One-message booking** — "book mumbai to delhi on <date>" skips the wizard.
- **Native WhatsApp buttons/lists** from the same suggestions the PWA renders as chips.
- **Seat selection** with a live seat map + tiered pricing, written to the booking.
- **PDF e-ticket** on demand, re-authenticated.
- **Proactive delay notifications** — an ops event pushes WhatsApp + rides the
  next chat turn.
- **Hinglish** understanding ("meri ticket radd karo").

---

## Slide 12 — Scope, honesty, and what's next

- Payments simulated (with a **declined-payment retry** path to show the unhappy flow).
- Agent queue simulated; hooks are ready to route to a real console (n8n → Slack/Zendesk).
- Roadmap in FUTURE_ENHANCEMENTS: real payments/OTP, agent console, relative-date
  parsing, streaming replies.

_We kept scope tight and documented every assumption instead of faking depth._

---

## Slide 13 — Thank you / links

- **Live demo:** WhatsApp test number + PWA
- **Repo:** source, README, docs/
- **Run it:** `docker compose up -d` → chat at :3000
- Built in 48h with Claude Code (dev) + OpenRouter (runtime intent) — see
  docs/ai-tools-used.md

---

### Criteria coverage cheat-sheet (for Q&A)

| Criterion | Weight | Where we show it |
|---|---|---|
| Working Product (UI/UX, self-service) | 30% | Slides 3, 6 — live demo on both channels |
| Innovation & Product Thinking | 20% | Slides 3, 5, 11 |
| Solution Design & NFRs | 15% | Slides 7, 9 |
| Business Understanding | 15% | Slides 2, 4 |
| Engineering Quality | 10% | Slides 8, 10 |
| Presentation & Demo | 10% | Slide 6 + delivery |
