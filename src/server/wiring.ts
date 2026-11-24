import "server-only";
import { env } from "./lib/env";
import { log } from "./lib/logger";
import { configurePaymentGateways } from "./payments/registry";
import { registerEngineSagaApi, sagaNotifier } from "./payments/saga";
import { stripeConfigProblems, stripeMode } from "./payments/stripe/stripe.config";
import { stripeGatewayFromEnv } from "./payments/stripe/stripe-gateway";
import { engineSagaApi } from "./services/engine-saga.service";

/**
 * Composition root for the B3 payment saga (doc 22 §23 B3). The saga and the
 * supplier engine know each other only through the frozen seams in
 * `payments/contracts.ts`; this module joins them once per process. Import it
 * (for its side effect, or for `sagaNotifier`) from every entry point that can
 * move a payment or a supplier attempt: the supplier worker, the payments job,
 * checkout and the payment webhook.
 *
 * It also gives the payment registry its gateways from `env()` (doc 22
 * §32.11): the Stripe gateway when `PAYMENTS_STRIPE` is `test` or `live` and
 * its whole configuration is valid, otherwise none (every rail
 * NOT_CONFIGURED, the default). Production is `APP_ENV`, not `NODE_ENV`, so
 * a staging build can run Stripe test mode.
 */
registerEngineSagaApi(engineSagaApi);

let stripeRefusalLogged = false;

configurePaymentGateways(() => {
  const e = env();
  const stripe = stripeGatewayFromEnv(e);
  if (!stripe && stripeMode(e) === "unconfigured" && !stripeRefusalLogged) {
    stripeRefusalLogged = true;
    log.error("payments.stripe_refused", { problems: stripeConfigProblems(e) });
  }
  return { gateways: stripe ? [stripe] : [], production: e.isProduction };
});

export { sagaNotifier };
