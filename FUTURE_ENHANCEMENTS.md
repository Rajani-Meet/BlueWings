# Future Enhancements — BlueWings Airlines

Out of scope for the MVP (locked to 4 flows), logged here instead of built.

## Product

- Seat selection (visual seat map in chat / PWA)
- Baggage allowance and paid add-ons
- Real payment gateway (Razorpay/Stripe) with fare rules and cancellation fees;
  price-difference handling on reschedule
- Real OTP verification via SMS or WhatsApp template messages
- Multi-city and group bookings
- WhatsApp interactive messages (buttons, list pickers) instead of numbered text options
- Flight change notifications (delay/gate change pushed proactively)
- Multi-lingual support and language auto-detection

## Agent handoff (currently UI-state only)

- Real agent queue with a human console (n8n could route to Slack/Zendesk)
- Conversation transcript handed to the agent
- Post-handoff resolution flow returning the user to the bot

## Technical

- Booking history / audit table (status transitions with timestamps)
- LLM-driven slot filling for the whole flow (multi-slot extraction in one turn,
  e.g. "book BOM to DEL tomorrow morning" pre-fills origin/destination/date)
- Conversation-context-aware intent parsing (send recent turns to the LLM)
- Streaming replies in the PWA; read receipts and typing states via WebSocket
- n8n error-handling workflow (retry Graph API sends, dead-letter alerts)
- Rate limiting and abuse protection on /api/message
- Observability: structured logs shipped to a collector, metrics per flow
- CI pipeline running vitest + tsc against a docker-compose Postgres
- Deploy manifests for Vercel (frontend) and Railway/Render (backend + DB)
