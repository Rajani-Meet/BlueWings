# Architecture

## System overview (Docker Compose)

```mermaid
graph TD
    subgraph Channels
        WA[WhatsApp user]
        PWA[PWA chat user<br/>localhost:3000]
    end

    subgraph n8n [n8n container :5679]
        HOOK[Webhook /webhook/whatsapp]
        VERIFY[GET: Meta verify handshake]
        EXTRACT[Code: translate Meta envelope]
        CALLBE[HTTP: POST backend /api/message]
        SENDWA[HTTP: Graph API send reply]
        HOOK --> VERIFY
        HOOK --> EXTRACT --> CALLBE --> SENDWA
    end

    subgraph frontend [frontend container :3000]
        NEXT[Next.js server<br/>rewrites /api/* to backend]
    end

    subgraph backend [backend container :4000]
        ROUTE[Express routes]
        CTRL[message.controller<br/>processIncomingMessage]
        INTENT[intentRouter service<br/>OpenRouter LLM + keyword fallback]
        FLOWS[Dialogue state machine<br/>CHECK_STATUS / BOOK / RESCHEDULE / CANCEL]
        SVC[booking / auth / payment /<br/>session / agentHandoff services]
        ADAPT[whatsapp.adapter<br/>fallback direct webhook]
    end

    DB[(PostgreSQL container :5433<br/>Prisma)]
    OR[OpenRouter API]
    META[Meta Graph API]

    WA -->|Meta webhook| HOOK
    SENDWA --> META --> WA
    PWA --> NEXT -->|proxied| ROUTE
    ROUTE --> CTRL --> INTENT --> OR
    CTRL --> FLOWS --> SVC --> DB
    CALLBE --> ROUTE
    ADAPT -.->|no-n8n fallback| CTRL
```

## Key decisions

- **Channel-agnostic core.** All conversation logic lives behind `processIncomingMessage(payload)`. The PWA hits it via `POST /api/message`; WhatsApp reaches the same function through n8n (primary) or the Express adapter (fallback). Adapters only translate message formats — no business logic.
- **n8n as the WhatsApp orchestration layer.** The webhook handshake, envelope translation, backend call, and Graph API reply are a visual, editable workflow (`n8n/workflows/bluewings-whatsapp.json`), auto-imported and activated when the container starts.
- **LLM with a deterministic safety net.** OpenRouter (comma-separated model fallback list, max 3) parses intent; output is zod-validated. On timeout (9s), non-200, invalid JSON, or confidence < 0.55, a keyword router takes over — an LLM outage never breaks a flow. Mid-flow inputs (slot values like "BOM" or "yes") skip the LLM entirely.
- **Dialogue state in the database.** `ConversationSession` stores flow, step, slots, and the handoff flag per (channel, userId), so conversations survive restarts and work identically across channels.
- **All booking mutations in `prisma.$transaction()`** — no partial writes.

## Conversation lifecycle

```mermaid
sequenceDiagram
    participant U as User (WA/PWA)
    participant A as Adapter / n8n
    participant C as Core (controller)
    participant I as Intent router
    participant S as Services + Prisma

    U->>A: "cancel my booking BW9003"
    A->>C: {channel, userId, message}
    C->>S: load ConversationSession
    C->>I: parseIntent (LLM → keyword fallback)
    I-->>C: CANCEL + slots {pnr: BW9003}
    C->>S: state machine step (auth → confirm → mutate in $transaction)
    C-->>A: {reply, sessionState, agentHandoff}
    A-->>U: reply (Graph API / HTTP JSON)
```
