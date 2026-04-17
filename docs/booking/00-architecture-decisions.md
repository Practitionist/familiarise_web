# Architecture Decision Records (ADR)

## ADR 001: 30-Minute Slot Granularity
- **Context**: The system needs a standardized way to manage consultant availability and bookings.
- **Decision**: All availability and appointment slots are fixed at 30-minute intervals.
- **Consequences**: Simplifies conflict detection and progress calculation. Durations must be multiples of 0.5 hours.

## ADR 002: PostgreSQL Timestamptz for Financial/Scheduling Fields
- **Context**: Multi-region deployments lead to timezone drift in standard `DateTime` fields.
- **Decision**: Use `TIMESTAMPTZ` for all load-bearing fields (`expiresAt`, `startsAt`, `endsAt`, `createdAt`, `updatedAt`).
- **Consequences**: Database handles UTC conversion automatically. Prevents scheduling errors across continents.

## ADR 003: Anchor-style Two-Phase Commit for Refunds
- **Context**: Network failures during gateway calls can leave refund records in an inconsistent state.
- **Decision**: Use a `PENDING` status with a client-generated `clientRefundId` before calling the gateway.
- **Consequences**: Allows idempotent retries and automated reconciliation via cron if the gateway update fails.
