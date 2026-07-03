# Future Enhancements — BlueWings Airlines

Out of scope for the MVP (locked to 4 flows), logged here instead of built.

## Product

- Seat selection (visual seat map in chat / PWA)
- Baggage allowance and paid add-ons
- Real payment gateway (Razorpay/Stripe) with fare rules and cancellation fees;
  price-difference handling on reschedule (a simulated declined-payment + retry
  path now exists: phone numbers ending 0000 are declined)
- Real OTP verification via SMS or WhatsApp template messages
- Multi-city and group bookings
- ~~WhatsApp interactive messages (buttons, list pickers)~~ ✅ Done — suggestions
  render as native reply buttons / list messages on WhatsApp
- ~~Flight change notifications (delay pushed proactively)~~ ✅ Done — simulated
  via `POST /api/ops/simulate-delay/:pnr` (WhatsApp push + next-turn chat notice);
  real-time carrier feeds remain future work
- Full multi-lingual support and language auto-detection (Hinglish/Hindi input
  is now understood; replies are still English-only)

## Agent handoff (currently a simulated queue)

- Real agent queue with a human console (n8n could route to Slack/Zendesk)
- Conversation transcript handed to the agent
- Agent-initiated resolution (the user-initiated 'menu' return to the bot exists)

## Technical

- Booking history / audit table (status transitions with timestamps)
- ~~LLM-driven slot filling (one-turn multi-slot extraction)~~ ✅ Done — "book
  mumbai to delhi on 2026-07-06" jumps straight to flight options; relative
  dates ("tomorrow morning") remain future work
- Conversation-context-aware intent parsing (send recent turns to the LLM)
- Streaming replies in the PWA; read receipts and typing states via WebSocket
- n8n error-handling workflow (retry Graph API sends, dead-letter alerts)
- ~~Rate limiting on /api/message~~ ✅ Done — 30 req/min per IP with a friendly reply
- Observability: structured logs shipped to a collector, metrics per flow
- ~~CI pipeline (vitest + tsc against Postgres)~~ ✅ Done — .github/workflows/ci.yml
- ~~Deploy manifests~~ ✅ Done — render.yaml + docs/deployment.md (deploying needs accounts)
