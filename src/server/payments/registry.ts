import { Errors } from "../lib/errors";
import { FAKE_PROVIDERS } from "./fake-gateways";
import type { PaymentGateway, PaymentRail } from "./contracts";
import { StripeGateway } from "./stripe/stripe-gateway";

/**
 * Payment gateway registry: which gateway serves each rail.
 *
 * Two kinds of gateway are accepted, nothing else:
 *  - fakes, only outside production, and only as instances a caller passes in
 *    (tests, a local drill); this module never creates one, so no build can
 *    reach a fake by configuration alone;
 *  - the Stripe adapter (doc 22 §32.11), only when its environment matches:
 *    test mode outside production, live mode in production. Its config
 *    (`stripe.config.ts`) already refuses any other pairing; this is the
 *    second lock.
 *
 * One Stripe account serves several rails (AED and, until Razorpay exists,
 * INR by card). `account().rail` holds one rail, so the registry asks a
 * Stripe gateway for all of them (`rails()`) and maps each to the one
 * instance; it answers `forProvider("stripe")` once. A rail served twice is
 * still an error.
 *
 * `paymentGateways` (used by checkout, the saga, the inbox and the webhook
 * route) is empty, so every rail is NOT_CONFIGURED, until the server-only
 * composition root (`src/server/wiring.ts`) configures it from `env()`. This
 * module stays importable from unit tests: it reads no env module.
 */

export interface GatewayRegistry {
  /** The gateway for a rail; NOT_CONFIGURED when none is. */
  forRail(rail: PaymentRail): PaymentGateway;
  /** The gateway answering for a provider name (the webhook route's path segment), or null. */
  forProvider(provider: string): PaymentGateway | null;
}

function isFake(provider: string): boolean {
  return (FAKE_PROVIDERS as readonly string[]).includes(provider);
}

/** Whether this registry may serve the gateway at all. */
function admitted(g: PaymentGateway, production: boolean): boolean {
  const a = g.account();
  if (isFake(a.provider)) return !production;
  if (g instanceof StripeGateway) return a.environment === (production ? "production" : "test");
  return false;
}

/** Every rail the gateway serves: a Stripe gateway reports its list, any other its account's one rail. */
function railsOf(g: PaymentGateway): readonly PaymentRail[] {
  return g instanceof StripeGateway ? g.rails() : [g.account().rail];
}

/**
 * A registry over the given gateways. A gateway that is neither a fake nor
 * the Stripe adapter is refused; fakes are refused in production; Stripe is
 * refused when its mode does not match.
 */
export function createGatewayRegistry(gateways: PaymentGateway[], opts: { production?: boolean } = {}): GatewayRegistry {
  const production = opts.production ?? process.env.NODE_ENV === "production";
  const byRail = new Map<PaymentRail, PaymentGateway>();
  const byProvider = new Map<string, PaymentGateway>();
  for (const g of gateways) {
    if (!admitted(g, production)) continue;
    const a = g.account();
    for (const rail of railsOf(g)) {
      if (byRail.has(rail)) throw new Error(`Two gateways for rail ${rail}`);
      byRail.set(rail, g);
    }
    if (byProvider.has(a.provider) && byProvider.get(a.provider) !== g) throw new Error(`Two gateways for provider ${a.provider}`);
    byProvider.set(a.provider, g);
  }
  return {
    forRail(rail) {
      const g = byRail.get(rail);
      if (!g) throw Errors.notConfigured(`Payment gateway for ${rail}`);
      return g;
    },
    forProvider(provider) {
      return byProvider.get(provider) ?? null;
    },
  };
}

/** What the composition root supplies: the gateways and whether this is production (APP_ENV). */
export type GatewaySource = () => { gateways: PaymentGateway[]; production: boolean };

let source: GatewaySource | null = null;
let built: GatewayRegistry | null = null;

/** Called once by `src/server/wiring.ts`. The registry is built on first use, from the source. */
export function configurePaymentGateways(next: GatewaySource | null): void {
  source = next;
  built = null;
}

function current(): GatewayRegistry {
  if (built) return built;
  const s = source?.();
  built = createGatewayRegistry(s?.gateways ?? [], s ? { production: s.production } : {});
  return built;
}

/** The process registry: nothing is configured until wiring supplies a qualified provider. */
export const paymentGateways: GatewayRegistry = {
  forRail: (rail) => current().forRail(rail),
  forProvider: (provider) => current().forProvider(provider),
};

/** The rail an order's charged currency travels on. */
export function railForCurrency(currency: string): PaymentRail | null {
  return currency === "INR" ? "inr_pacb" : currency === "AED" ? "aed_card" : null;
}
