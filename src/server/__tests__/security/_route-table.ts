import { uuidv7 } from "@/server/lib/ids";

/**
 * The route table for H04 (origin and media type on mutation routes), shared
 * by origin-media.test.ts (the DB-backed calls) and route-contracts.test.ts
 * (the always-on unit check that the table covers every mutation handler).
 */

export const ID = uuidv7();
export const ID2 = uuidv7();

export type Auth = "admin" | "customer" | "public" | "pending";
/** json: body parsed by `parseJson`; none: no body read; optional: may be empty, JSON if not. */
export type BodyKind = "json" | "none" | "optional";
export interface RouteCase {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  file: string;
  auth: Auth;
  body: BodyKind;
  params?: Record<string, string>;
  /** multipart is an accepted upload format on this route (authenticated, origin-checked). */
  multipartAllowed?: boolean;
  load: () => Promise<Record<string, unknown>>;
}

const R = (method: RouteCase["method"], file: string, auth: Auth, body: BodyKind, load: RouteCase["load"], extra: Partial<RouteCase> = {}): RouteCase => {
  const p = extra.params ?? {};
  const urlPath = `/api/${file}`.replace("[id]", p.id ?? "").replace("[itemId]", p.itemId ?? "").replace("[reference]", p.reference ?? "");
  return { method, path: urlPath, file, auth, body, load, ...extra };
};
const id = { params: { id: ID } };

export const ROUTES: RouteCase[] = [
  R("POST", "admin/activities", "admin", "json", () => import("@/app/api/admin/activities/route")),
  R("PATCH", "admin/activities/[id]", "admin", "json", () => import("@/app/api/admin/activities/[id]/route"), id),
  R("DELETE", "admin/activities/[id]", "admin", "json", () => import("@/app/api/admin/activities/[id]/route"), id),
  R("POST", "admin/activities/[id]/duplicate", "admin", "none", () => import("@/app/api/admin/activities/[id]/duplicate/route"), id),
  R("POST", "admin/activities/[id]/restore", "admin", "none", () => import("@/app/api/admin/activities/[id]/restore/route"), id),
  R("POST", "admin/activities/[id]/restore-version", "admin", "json", () => import("@/app/api/admin/activities/[id]/restore-version/route"), id),
  R("POST", "admin/activities/[id]/status", "admin", "json", () => import("@/app/api/admin/activities/[id]/status/route"), id),
  R("POST", "admin/auth/login", "public", "json", () => import("@/app/api/admin/auth/login/route")),
  R("POST", "admin/auth/logout", "admin", "none", () => import("@/app/api/admin/auth/logout/route")),
  R("POST", "admin/auth/totp/enrol", "pending", "none", () => import("@/app/api/admin/auth/totp/enrol/route")),
  R("POST", "admin/auth/totp/verify", "pending", "json", () => import("@/app/api/admin/auth/totp/verify/route")),
  R("POST", "admin/categories", "admin", "json", () => import("@/app/api/admin/categories/route")),
  R("PATCH", "admin/categories/[id]", "admin", "json", () => import("@/app/api/admin/categories/[id]/route"), id),
  R("DELETE", "admin/categories/[id]", "admin", "json", () => import("@/app/api/admin/categories/[id]/route"), id),
  R("POST", "admin/imports/[id]/apply", "admin", "json", () => import("@/app/api/admin/imports/[id]/apply/route"), id),
  R("POST", "admin/imports/[id]/revert", "admin", "json", () => import("@/app/api/admin/imports/[id]/revert/route"), id),
  R("POST", "admin/imports/fetch", "admin", "json", () => import("@/app/api/admin/imports/fetch/route")),
  R("POST", "admin/imports/preview", "admin", "json", () => import("@/app/api/admin/imports/preview/route"), { multipartAllowed: true }),
  R("POST", "admin/products/[id]/fulfilment-mode", "admin", "json", () => import("@/app/api/admin/products/[id]/fulfilment-mode/route"), id),
  R("PUT", "admin/settings", "admin", "json", () => import("@/app/api/admin/settings/route")),
  R("POST", "admin/users", "admin", "json", () => import("@/app/api/admin/users/route")),
  R("PATCH", "admin/users/[id]", "admin", "json", () => import("@/app/api/admin/users/[id]/route"), id),
  R("POST", "admin/users/[id]/reset", "admin", "optional", () => import("@/app/api/admin/users/[id]/reset/route"), id),
  R("POST", "agent/inquiries/[id]/assign", "admin", "json", () => import("@/app/api/agent/inquiries/[id]/assign/route"), id),
  R("POST", "agent/inquiries/[id]/claim", "admin", "none", () => import("@/app/api/agent/inquiries/[id]/claim/route"), id),
  R("POST", "agent/inquiries/[id]/contact", "admin", "json", () => import("@/app/api/agent/inquiries/[id]/contact/route"), id),
  R("POST", "agent/inquiries/[id]/convert", "admin", "json", () => import("@/app/api/agent/inquiries/[id]/convert/route"), id),
  R("PATCH", "agent/inquiries/[id]/items/[itemId]", "admin", "json", () => import("@/app/api/agent/inquiries/[id]/items/[itemId]/route"), { params: { id: ID, itemId: ID2 } }),
  R("POST", "agent/inquiries/[id]/notes", "admin", "json", () => import("@/app/api/agent/inquiries/[id]/notes/route"), id),
  R("POST", "agent/inquiries/[id]/spam", "admin", "json", () => import("@/app/api/agent/inquiries/[id]/spam/route"), id),
  R("POST", "agent/inquiries/[id]/status", "admin", "json", () => import("@/app/api/agent/inquiries/[id]/status/route"), id),
  R("POST", "agent/inquiries/[id]/unassign", "admin", "json", () => import("@/app/api/agent/inquiries/[id]/unassign/route"), id),
  R("POST", "agent/notifications/[id]/resend", "admin", "none", () => import("@/app/api/agent/notifications/[id]/resend/route"), id),
  R("POST", "auth/logout", "customer", "none", () => import("@/app/api/auth/logout/route")),
  R("POST", "auth/otp/request", "public", "json", () => import("@/app/api/auth/otp/request/route")),
  R("POST", "auth/otp/verify", "public", "json", () => import("@/app/api/auth/otp/verify/route")),
  R("POST", "auth/otp/widget", "public", "json", () => import("@/app/api/auth/otp/widget/route")),
  R("POST", "inquiries", "public", "json", () => import("@/app/api/inquiries/route")),
  R("POST", "inquiries/lookup", "public", "json", () => import("@/app/api/inquiries/lookup/route")),
  R("POST", "me/delete-request", "customer", "optional", () => import("@/app/api/me/delete-request/route")),
  R("PUT", "me/preferences", "customer", "json", () => import("@/app/api/me/preferences/route")),
  R("PATCH", "me", "customer", "json", () => import("@/app/api/me/route")),
  R("POST", "quotes", "public", "json", () => import("@/app/api/quotes/route")),
  R("POST", "checkout", "public", "json", () => import("@/app/api/checkout/route")),
  R("POST", "checkout/verify", "public", "json", () => import("@/app/api/checkout/verify/route")),
  R("POST", "checkout/verify/start", "public", "json", () => import("@/app/api/checkout/verify/start/route")),
  // B4 tickets (TKT-5, TKT-6): the capability exchange and the staff resend.
  R("POST", "tickets/exchange", "public", "json", () => import("@/app/api/tickets/exchange/route")),
  // Checkout redesign batch 3 review: "Remove access on this browser" (no body; idempotent).
  R("POST", "tickets/remove-access", "public", "none", () => import("@/app/api/tickets/remove-access/route")),
  R("POST", "tickets/orders/[reference]/resend", "admin", "none", () => import("@/app/api/tickets/orders/[reference]/resend/route"), { params: { reference: "OUT-10000017" } }),
  // B5 customer journeys (F15, F23, F51). Public: ownership (or the recovery
  // challenge) is checked inside, after the origin and media-type checks.
  R("POST", "orders/[reference]/cancellation", "public", "json", () => import("@/app/api/orders/[reference]/cancellation/route"), { params: { reference: "OUT-10000017" } }),
  R("POST", "recovery/start", "public", "json", () => import("@/app/api/recovery/start/route")),
  R("POST", "recovery/verify", "public", "json", () => import("@/app/api/recovery/verify/route")),
];

/**
 * Mutation handlers that authenticate without a browser (signature or job
 * secret). The webhook, the events beacon and inquiry-sweep are exercised as
 * exceptions in origin-media.test.ts; every jobs/* handler is also checked
 * statically to call requireCron first (route-contracts.test.ts).
 */
export const NON_BROWSER = new Set([
  "POST webhooks/whatsapp",
  "POST jobs/inquiry-sweep",
  "POST jobs/offline-conversions",
  "POST jobs/supplier-worker",
  "POST jobs/supplier-reconcile",
  "POST jobs/payments-tick",
  "POST jobs/documents-tick",
  "POST jobs/fx-refresh",
  "POST jobs/crm-worker",
  "POST jobs/catalogue-sync",
  "POST jobs/retention-purge",
  "POST webhooks/payments/[provider]",
  "POST events",
]);
