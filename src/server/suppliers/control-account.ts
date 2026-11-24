import type { SupplierEnvironment } from "@prisma/client";

/**
 * Which supplier account's booking controls an environment uses (SUP-10).
 * Pure, so the admin page and the admin write action pick the same row and a
 * unit test can prove it (doc 29 §7.3, defect D2).
 */

/** The account segment in test while no agency id is pinned (SUP-10). Never used in production. */
export const DEFAULT_BOOKING_ACCOUNT_ID = "default";

/** The account a worker or intake acts for: the pinned id, else `default` in test, else none (mutations refused). */
export function bookingAccountId(environment: SupplierEnvironment, pinned: string | null | undefined): string | null {
  if (pinned) return pinned;
  return environment === "test" ? DEFAULT_BOOKING_ACCOUNT_ID : null;
}

/**
 * The account whose control row an environment shows and changes on this
 * deployment: the pinned agency id when the deployment's TravelDesk key is
 * for that environment, else `default` in test, else none (production with
 * no pin here).
 */
export function pinnedControlAccount(environment: SupplierEnvironment, config: { environment: SupplierEnvironment; agencyId?: string | null } | null | undefined): string | null {
  return bookingAccountId(environment, config?.environment === environment ? config.agencyId : null);
}
