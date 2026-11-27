import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/server/lib/db";
import { assertBootEnv, env } from "@/server/lib/env";
import { hasHealthDetailToken } from "@/server/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health — app + database + configuration warnings (§14.3).
 * Uptime monitors poll this from India and UAE. Returns 503 when the
 * database is unreachable; configuration warnings are informational.
 *
 * The warning texts describe the deployment's security configuration
 * ("CRON_SECRET missing", invalid env variable names), so anonymous callers
 * only get their count. Ops tooling sees the texts with its own token
 * (`Authorization: Bearer $HEALTH_DETAIL_TOKEN`). The cron secret never
 * unlocks them (SEC-8): it authorises scheduled jobs and nothing else.
 */
function canSeeWarnings(req: NextRequest): boolean {
  if (!req.headers.get("authorization") && !req.headers.get("x-health-token")) return false;
  try {
    return hasHealthDetailToken(req);
  } catch {
    // env() itself is invalid: no token can be checked, so no detail.
    return false;
  }
}

export async function GET(req: NextRequest) {
  const started = Date.now();
  let db: "ok" | "error" = "ok";
  let dbLatencyMs: number | null = null;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - started;
  } catch {
    db = "error";
  }

  let warnings: string[] = [];
  let appEnv = "unknown";
  try {
    appEnv = env().APP_ENV;
    warnings = assertBootEnv();
  } catch (e) {
    warnings = [e instanceof Error ? e.message : "env invalid"];
  }

  const body = {
    status: db === "ok" ? "ok" : "degraded",
    appEnv,
    db,
    dbLatencyMs,
    warningCount: warnings.length,
    ...(canSeeWarnings(req) ? { warnings } : {}),
    time: new Date().toISOString(),
  };
  return NextResponse.json(body, { status: db === "ok" ? 200 : 503, headers: { "cache-control": "no-store" } });
}
