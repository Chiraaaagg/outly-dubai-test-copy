import { createHash } from "node:crypto";
import { AppError } from "../lib/errors";
import { ManualAdapter } from "./manual/manual.adapter";
import type { SupplierPort } from "./port";
import { RathinLiveAdapter, rathinConfigFrom, type RathinEnvSlice } from "./rathin/rathin.adapter";
import { RathinMockAdapter } from "./rathin/rathin.mock";
import { TravelDeskLiveAdapter } from "./traveldesk/traveldesk.adapter";
import { traveldeskConfigFrom, type TravelDeskEnvSlice } from "./traveldesk/traveldesk.config";
import { TravelDeskMockAdapter } from "./traveldesk/traveldesk.mock";

/**
 * Supplier registry — `suppliers.adapter` + env → a `SupplierPort`.
 *
 *   adapter "manual" | "portal"  → ManualAdapter (portal suppliers are
 *                                  semi-manual until a PortalAdapter exists)
 *   adapter "rathin"             → RathinMockAdapter unless
 *                                  SUPPLIER_ADAPTER_RATHIN=live AND all
 *                                  RATHIN_* are set, then RathinLiveAdapter
 *   adapter "traveldesk"         → TravelDeskMockAdapter unless
 *                                  SUPPLIER_ADAPTER_TRAVELDESK=live, then
 *                                  TravelDeskLiveAdapter (read-only, Stage 1)
 *
 * `env` is a parameter, not an import: this module and every adapter must be
 * importable from unit tests, and `src/server/lib/env.ts` is "server-only".
 * Services pass `env()` (its `Env` type satisfies `SupplierEnv`); tests pass
 * a literal. Nothing in `src/server/suppliers/**` reads `process.env`.
 */

/** TravelDesk fields are optional so older callers and tests that only set Rathin keep compiling; absent ⇒ mock. */
export type SupplierEnv = RathinEnvSlice & TravelDeskEnvSlice;

export type SupplierSelector =
  /** A `suppliers.adapter` value. */
  | string
  /** A row-ish object, e.g. the `supplier` relation on a mapping. */
  | { adapter: string; code?: string };

export const KNOWN_ADAPTERS = ["manual", "portal", "rathin", "traveldesk"] as const;
export type KnownAdapter = (typeof KNOWN_ADAPTERS)[number];

export function isKnownAdapter(adapter: string): adapter is KnownAdapter {
  return (KNOWN_ADAPTERS as readonly string[]).includes(adapter);
}

/** Which Rathin adapter the env selects, for /api/health-style diagnostics. Never returns secrets. */
export function rathinMode(env: SupplierEnv): "mock" | "live" | "live_unconfigured" {
  if (env.SUPPLIER_ADAPTER_RATHIN !== "live") return "mock";
  return rathinConfigFrom(env) ? "live" : "live_unconfigured";
}

/**
 * One live TravelDesk adapter per configuration, so its availability cache,
 * request coalescing and per-instance request limit (TravelDesk handles one
 * agency's requests at a time) are shared by every caller instead of being
 * rebuilt per call. Keyed by a hash of the key, never the key itself.
 */
const travelDeskLive = new Map<string, TravelDeskLiveAdapter>();

function travelDeskLiveFor(env: SupplierEnv): TravelDeskLiveAdapter {
  const config = traveldeskConfigFrom(env);
  if (!config) return new TravelDeskLiveAdapter(null);
  const id = `${config.environment}:${config.readTimeoutMs}:${config.bookingsEnabled ? "bookings" : "read"}:${config.agencyId ?? "-"}:${createHash("sha256").update(config.apiKey).digest("hex")}`;
  let adapter = travelDeskLive.get(id);
  if (!adapter) {
    adapter = new TravelDeskLiveAdapter(config);
    travelDeskLive.set(id, adapter);
  }
  return adapter;
}

export function supplierFor(selector: SupplierSelector, env: SupplierEnv): SupplierPort {
  const adapter = typeof selector === "string" ? selector : selector.adapter;
  switch (adapter) {
    case "manual":
    case "portal":
      return new ManualAdapter();
    case "rathin":
      // `live_unconfigured` deliberately yields the LIVE adapter with a null
      // config so every call fails loudly with NOT_CONFIGURED — a half-set
      // production env must not silently fall back to the mock.
      return env.SUPPLIER_ADAPTER_RATHIN === "live" ? new RathinLiveAdapter(rathinConfigFrom(env)) : new RathinMockAdapter();
    case "traveldesk":
      // Same fail-loud rule: live but misconfigured ⇒ every call NOT_CONFIGURED.
      return env.SUPPLIER_ADAPTER_TRAVELDESK === "live" ? travelDeskLiveFor(env) : new TravelDeskMockAdapter();
    default:
      // The adapter string comes from the database, never from a request, but
      // it is still not echoed into the message.
      throw new AppError({
        status: 503,
        code: "NOT_CONFIGURED",
        message: "Unknown supplier adapter",
        recovery: "Fix `suppliers.adapter` for this supplier; valid values are manual, portal, rathin, traveldesk.",
        details: { adapter },
      });
  }
}
