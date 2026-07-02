# Database Schema

PostgreSQL via Prisma. Source of truth: [`backend/prisma/schema.prisma`](../backend/prisma/schema.prisma); migrations in `backend/prisma/migrations/`.

```mermaid
erDiagram
    Passenger ||--o{ Booking : has
    Flight ||--o{ Booking : has

    Passenger {
        string id PK "uuid"
        string name
        string email
        string phone UK
    }

    Flight {
        string id PK "uuid"
        string flightNumber UK "e.g. BW101"
        string origin "IATA code"
        string destination "IATA code"
        datetime departureTime
        datetime arrivalTime
        float price
    }

    Booking {
        string id PK "uuid"
        string pnr UK "BW + 4 digits"
        enum status "CONFIRMED | RESCHEDULED | CANCELLED"
        string flightId FK
        string passengerId FK
    }

    ConversationSession {
        string id PK "uuid"
        string channel "WHATSAPP | PWA"
        string channelUserId "phone / browser uuid"
        string stateJson "flow, step, slots"
        boolean agentHandoffActive
    }
```

## Notes

- **`Booking.pnr`** is the user-facing reference (`BW` + 4 digits), generated
  uniquely inside the booking transaction.
- **`ConversationSession`** has a unique compound key `(channel, channelUserId)` —
  one live conversation per user per channel. `stateJson` holds the dialogue
  state machine's position: `{ currentFlow, step, slots, auth, consecutiveFailedParses }`.
- **Rescheduling** repoints `Booking.flightId` and sets status `RESCHEDULED`;
  cancelling sets `CANCELLED`. History/audit tables are out of MVP scope.
- All booking mutations run inside `prisma.$transaction()`.

## Seed data (`backend/prisma/seed.ts`)

- ~96 flights: 6 routes (BOM/DEL/BLR pairs) × 8 days × morning + evening
- 5 passengers, 5 bookings — **BW9001–BW9004** confirmed, **BW9005** cancelled
- Demo login: PNR `BW9001`, last name `Doe`
