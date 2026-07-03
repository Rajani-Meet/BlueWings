# Public Deployment Guide

Local demo works with `docker compose up -d` alone. This guide is for a public
URL (judges try it without your laptop).

## Backend + database — Render (blueprint included)

1. Push the repo to GitHub.
2. Render dashboard → **New → Blueprint** → select the repo. Render reads
   [`render.yaml`](../render.yaml): a Node web service (`bluewings-backend`) and
   a free Postgres (`bluewings-db`), with migrations + seed on boot.
3. Set the secrets it prompts for: `OPENROUTER_API_KEY`, and (optionally)
   `WHATSAPP_ACCESS_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`.
4. Note the service URL, e.g. `https://bluewings-backend.onrender.com`
   (`/health` should answer).

## Frontend — Vercel

1. Vercel dashboard → **Add New → Project** → import the repo.
2. Set **Root Directory** to `frontend` (framework auto-detects Next.js).
3. Add env var `BACKEND_URL = https://bluewings-backend.onrender.com`
   (read at build time by `next.config.js` rewrites — redeploy after changing it).
4. Deploy. The chat is live at your `*.vercel.app` URL; `/api/*` calls proxy
   through the Next server to Render, so no CORS setup is needed.

## WhatsApp webhook in production

Two options:

- **Without n8n (simplest)**: point the Meta webhook straight at the backend —
  `https://bluewings-backend.onrender.com/api/webhook/whatsapp` with your
  `WHATSAPP_VERIFY_TOKEN`. The Express adapter handles everything, including
  interactive buttons.
- **With n8n**: run n8n on Render/Railway from the `n8nio/n8n` image with the
  env vars from `docker-compose.yml` (`BACKEND_INTERNAL_URL` → the Render
  backend URL, `WEBHOOK_URL` → the n8n public URL) and the same
  import-then-start command; point Meta at `https://<n8n-host>/webhook/whatsapp`.

## Gotchas

- **Render free tier sleeps** after idle — first request takes ~30s. Warm it
  before a demo (`curl /health`).
- **Meta temp tokens expire (~24h)** — refresh before demoing live WhatsApp,
  and make sure the recipient number is in Meta's allowed list.
- `SEED_ON_START=true` re-seeds demo data on every deploy/restart — disable if
  you want bookings to persist across restarts.
