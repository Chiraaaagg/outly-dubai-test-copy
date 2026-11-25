/**
 * Cancel TravelDesk TEST bookings left open by a drill (doc 22 §32.15, A5).
 *
 * The sandbox drill prints "LEFT OPEN ON TRAVELDESK TEST … cancel by hand" when
 * the engine could not close a drill booking itself. This cancels exactly the
 * supplier booking ids given, and nothing else.
 *
 * Safety: refuses unless the config resolves to TravelDesk's TEST environment.
 * The production key file is never read. No database is touched.
 *
 *   node --env-file=<path>/.env.traveldesk.local node_modules/tsx/dist/cli.mjs \
 *     scripts/traveldesk-cancel-test-booking.ts 303819 303822
 */
import { TravelDeskBookingClient } from "../src/server/suppliers/traveldesk/traveldesk.booking";
import { traveldeskConfigFrom, traveldeskConfigProblems } from "../src/server/suppliers/traveldesk/traveldesk.config";

const env = {
  APP_ENV: "development" as const,
  SUPPLIER_ADAPTER_TRAVELDESK: process.env.SUPPLIER_ADAPTER_TRAVELDESK as "mock" | "live" | undefined,
  TRAVELDESK_ENV: process.env.TRAVELDESK_ENV as "test" | "production" | undefined,
  TRAVELDESK_API_BASE_URL: process.env.TRAVELDESK_API_BASE_URL?.trim() || undefined,
  TRAVELDESK_API_KEY: process.env.TRAVELDESK_API_KEY?.trim() || undefined,
  TRAVELDESK_TIMEOUT_MS: Number(process.env.TRAVELDESK_TIMEOUT_MS ?? 150_000),
  TRAVELDESK_READ_TIMEOUT_MS: Number(process.env.TRAVELDESK_READ_TIMEOUT_MS ?? 30_000),
  // Enabled for this process only, after the TEST check below.
  TRAVELDESK_BOOKINGS_ENABLED: true,
};
if (env.TRAVELDESK_ENV !== "test") {
  console.error("REFUSED: TRAVELDESK_ENV must be test");
  process.exit(2);
}
const problems = traveldeskConfigProblems(env);
if (problems.length) {
  console.error(`REFUSED: ${problems.join("; ")}`);
  process.exit(2);
}
const config = traveldeskConfigFrom(env);
if (!config || config.environment !== "test") {
  console.error("REFUSED: only TravelDesk TEST is allowed");
  process.exit(2);
}

const ids = process.argv.slice(2);
if (!ids.length || ids.some((id) => !/^\d+$/.test(id))) {
  console.error("usage: <supplier booking id> […]");
  process.exit(2);
}

async function main() {
  const client = new TravelDeskBookingClient(config!, {});
  let failed = 0;
  for (const id of ids) {
    try {
      const r = await client.cancel(id);
      console.log(`#${id}: cancel answered`, JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    } catch (e) {
      failed++;
      console.error(`#${id}: cancel failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

void main();
