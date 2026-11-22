-- Expiry indexes for the daily retention purge (doc 29 Batch 1c,
-- src/server/jobs/retention-purge.ts; review 81 R8).
--
-- Forward-only and additive: five plain b-tree indexes, nothing else. Each
-- purge batch selects rows by `expires_at` (and, for capability grants, by
-- `revoked_at`); without these every batch is a sequential scan. No column,
-- constraint, row or function changes.
--
-- Plain CREATE INDEX, not CONCURRENTLY: CONCURRENTLY would need one
-- single-statement migration file per index, and the lock timeout and the
-- migration-safety suite assume one transaction per file. It holds a SHARE lock on each
-- table while its index builds, which blocks writes (new sessions, sign-in
-- codes, grants) for that time only. These tables are small at pilot size,
-- so the build takes well under a second. The lock timeout makes the
-- migration fail fast, to be retried, instead of queueing behind a long
-- query.
--
-- `otp_challenges_expires_idx` and `customer_sessions_expires_idx` reuse the
-- names of two indexes that 20260918175017 created outside the Prisma schema
-- and 20260919085708 dropped as drift; they are declared in schema.prisma
-- this time, so a later generated migration keeps them.

SET LOCAL lock_timeout = '5s';

CREATE INDEX "otp_challenges_expires_idx" ON "otp_challenges"("expires_at");

CREATE INDEX "customer_sessions_expires_idx" ON "customer_sessions"("expires_at");

CREATE INDEX "admin_sessions_expires_idx" ON "admin_sessions"("expires_at");

CREATE INDEX "guest_capability_grants_expires_idx" ON "guest_capability_grants"("expires_at");

CREATE INDEX "guest_capability_grants_revoked_idx" ON "guest_capability_grants"("revoked_at");
