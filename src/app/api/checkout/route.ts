import "@/server/wiring";
import { checkoutService } from "@/server/payments/checkout.service";
import { checkoutDownloadGrant } from "@/server/services/checkout-download-grant.service";
import { createCheckoutHandler } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/checkout — see `createCheckoutHandler` for the order of checks and the response. */
export const POST = createCheckoutHandler(
  () => checkoutService,
  () => checkoutDownloadGrant,
);
