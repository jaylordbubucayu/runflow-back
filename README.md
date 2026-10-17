# RunFlow Backend — NestJS + TypeORM (MySQL)

Generated from `runflow-erd.mermaid` and the accompanying backend architecture doc.
Covers the full P0/P1 flow: create event → register → pay → QR → check-in →
result → stats/achievements.

## Stack

NestJS · TypeORM (`mysql2` driver) · class-validator/class-transformer ·
Passport JWT · `@nestjs/event-emitter` (domain events) · BullMQ + Redis
(certificate generation queue) · MySQL 8.

## Getting started

```bash
npm install
cp .env.example .env   # fill in DB/Redis/JWT/PayMongo secrets
```

You'll need a running MySQL 8 instance and a Redis instance (for BullMQ).
`synchronize` is intentionally left `false` in `src/data-source.ts` — this
project is migration-driven, not auto-sync, even in development.

```bash
# generate a migration from the current entities, then run it
npm run migration:generate -- src/migrations/InitSchema
npm run migration:run

npm run start:dev
```

The API listens on `http://localhost:3000/api` (global prefix set in `main.ts`).

## Project layout

Mirrors the module map from the architecture doc — one NestJS module per
folder under `src/`, each with its own `entities/`, `dto/`, `*.service.ts`,
`*.controller.ts`, and `*.module.ts`:

```
src/
├── auth/            # JWT login/register/Google OAuth, guards, roles
├── users/           # User + RunnerProfile
├── organizations/   # Organizer accounts
├── events/          # Event + categories/prizes/freebies/checkpoints, wizard steps
├── registrations/   # Registration wizard, atomic slot reservation, QR issuance
├── payments/         # PayMongo checkout + idempotent webhook, fee calc
├── checkin/          # QR resolve + check-in state machine
├── results/          # Bulk import, leaderboards, emits `result.published`
├── runner-stats/     # Derived stats: PBs, achievements (listens for events)
├── certificates/      # BullMQ-queued PDF generation (listens for events)
├── notifications/    # In-app feed (listens for every domain event)
├── admin/            # Platform dashboard, revenue, fee config, org/user mgmt
├── common/           # enums, QrService, money util
├── data-source.ts    # TypeORM CLI datasource (migrations)
├── app.module.ts
└── main.ts
```

## What's implemented vs. stubbed

**Fully implemented, matching the doc's "notes that will save you a rewrite"
section (§4):**

- **Slot concurrency (§4.1):** `EventsService.reserveSlot` uses an atomic
  `UPDATE event_categories SET slots_remaining = slots_remaining - 1 WHERE
  id = ? AND slots_remaining > 0` and checks affected rows — no
  `SELECT ... FOR UPDATE` needed, no race on the last slot.
- **QR tokens (§4.2):** `QrService` HMAC-signs `registrationId + timestamp`;
  raw ids are never encoded directly.
- **Money as integers (§4.3):** `common/services/money.util.ts` does all fee
  arithmetic in centavos before formatting back to `DECIMAL(10,2)` strings.
- **Idempotent webhooks (§4.4):** `PaymentsService.handleWebhook` matches on
  `provider_payment_id`, no-ops if the payment is already `paid`, and wraps
  "mark paid + assign bib + decrement slot" in a single DB transaction
  (`DataSource.transaction`).
- **1:1 modeling (§4.5):** `Registration ↔ Result/Certificate/CheckIn` all
  put the FK on the child table with a unique index, not a join table.
- **Derived stats (§4.6):** `RunnerStatsService` only ever reads from
  `Registration`/`Result` and can be safely dropped/rebuilt.
- **Domain events (§3):** wired through `EventEmitterModule` —
  `payment.succeeded`, `registration.checked_in`, `result.published`,
  `achievement.earned` all fire and are consumed cross-module exactly as
  the doc's table describes.

**Deliberately stubbed (marked `// TODO` in code) — these need real
credentials/infra to finish:**

- `PaymentsService.verifySignature` — swap in PayMongo's actual HMAC webhook
  verification scheme once you have `PAYMONGO_WEBHOOK_SECRET`.
- `PaymentsService.createCheckout` — swap the mock checkout URL for a real
  PayMongo SDK/HTTP call.
- `CertificatesService.generate` — currently returns a placeholder URL;
  wire up your PDF renderer + S3-compatible upload here.
- `AuthService.googleLogin` — expects an already-verified Google profile
  (`googleId`, `email`); wire in `passport-google-oauth20` upstream if you
  want the full OAuth redirect dance handled server-side.
- `EventsController` doesn't yet expose a checkpoint endpoint (P1 per the
  doc) — `EventsService.addCheckpoint` exists and is ready to wire up.

## Auth / guards

- `JwtAuthGuard` — standard bearer-token auth.
- `RolesGuard` + `@Roles(UserRole.ADMIN | ORGANIZER | RUNNER)` — role checks.
- `OrganizationOwnerGuard` — confirms an organizer only touches events under
  their own `Organization`; admins bypass it. Apply it alongside
  `RolesGuard` on any organizer-scoped event route once you wire the
  organizer's org lookup into the route params.

## Migrations

This project does **not** use `synchronize: true`. Generate and run
migrations explicitly:

```bash
npm run migration:generate -- src/migrations/YourMigrationName
npm run migration:run
npm run migration:revert   # if you need to roll back
```
