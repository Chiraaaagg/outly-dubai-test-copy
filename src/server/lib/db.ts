import "server-only";
import { PrismaClient } from "@prisma/client";
import { recordPhase } from "./request-timing";

/**
 * The only module outside `src/server/repositories/**` that imports Prisma
 * (docs/backend/03-tech-stack.md §3.3). Singleton across hot reloads; Neon's
 * pooled connection string (DATABASE_URL) keeps serverless connection counts
 * sane, DIRECT_URL is for migrations only.
 */

const globalForPrisma = globalThis as unknown as { __outlyyPrisma?: PrismaClient };

/**
 * The client, with one query extension: each operation's duration is added to
 * the current request's `db` timing (doc 29 §6.6; src/server/lib/request-timing.ts).
 * Outside a timed request it records nothing. Arguments and results pass
 * through unchanged; nothing about the query is kept. Typed as the base
 * client so `Tx` and every caller stay as they were (no extension adds a
 * model method or a result field).
 */
function createClient(): PrismaClient {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
  return base.$extends({
    name: "request-timing",
    query: {
      async $allOperations({ args, query }) {
        const started = performance.now();
        try {
          return await query(args);
        } finally {
          recordPhase("db", performance.now() - started);
        }
      },
    },
  }) as unknown as PrismaClient;
}

export const prisma: PrismaClient = globalForPrisma.__outlyyPrisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.__outlyyPrisma = prisma;

export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/**
 * Interactive-transaction budget. Prisma's default (5s) assumes a co-located
 * database; the inquiry→order conversion runs ~10 statements in one
 * transaction and must not fail on a slow link. Pass to every
 * `prisma.$transaction(async (tx) => …, TX_OPTIONS)`.
 */
export const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;
