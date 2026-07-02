# Assumptions Document - BlueWings Airlines MVP

This document outlines key product and technical assumptions made during the implementation of the BlueWings Airlines Conversational Booking & Servicing MVP.

## 1. Local Database Engine
- **Assumption**: We assume that if PostgreSQL local authentication fails or credentials are not supplied, SQLite can be used as a development fallback database (e.g. `file:./dev.db`) to enable rapid and frictionless testing of the Prisma schema. Production configurations will target PostgreSQL.
- **Rationale**: Prevents local setup blockers for the user/evaluator when Postgres port 5432 is occupied or requires credentials.

## 2. Authentication Flow
- **Assumption**: A user is considered authenticated once they provide a valid PNR matching their last name. We do not require real SMS/email OTP, but mock verification states can be triggered for the booking flow.

## 3. Simulated Payments
- **Assumption**: Payment simulation will immediately return success with a generated transaction ID. No real credit card or gateway logic will be integrated.
