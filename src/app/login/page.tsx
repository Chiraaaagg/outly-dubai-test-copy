import type { Metadata } from "next";
import { headers } from "next/headers";
import { Breadcrumbs } from "@/components/ui/primitives";
import { Scene } from "@/components/ui/scene";
import { customerAuthService } from "@/server/services/customer-auth.service";
import { env } from "@/server/lib/env";
import { loginDescription, parseLoginNotice, type CustomerAuthOptions } from "@/lib/customer-auth-options";
import { PILOT_PARAM, pilotShownOptions } from "@/server/auth/pilot";
import { safeNext } from "@/lib/safe-next";
import type { EmailFormPreview } from "@/components/auth/email-code-form";
import { LoginClient } from "./login-client";

/**
 * SIGN IN (Group B, side-session plan 92 §6; Login 16 adapted).
 *
 * Rendered on the server from `customerAuthService.options()`, so the page
 * shows exactly the sign-in methods that work in this deployment: an email
 * code and Google (when configured), the phone code only while SMS can
 * deliver, no Apple. Dynamic because the options are runtime configuration.
 * `?next=` is honoured only for storefront paths (`safeNext`); `?e=` carries a
 * short notice from the Google callback, never provider text.
 *
 * Development only: `?preview=<state>` opens a designed state of the email
 * form directly (code sent, wrong code, too many tries, closed account, long
 * address) for review and screenshots. Ignored outside APP_ENV=development.
 *
 * Owner-only pilot (CUSTOMER_AUTH_PILOT_EMAILS set): the email and Google
 * options show only with `?pilot=1`; the phone option is unchanged. The
 * description says only what the page offers (`loginDescription`).
 */

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The options this request shows: the deployment's, less email and Google during the pilot without `?pilot=1`. */
function shownOptions(sp: Record<string, string | string[] | undefined>): { options: CustomerAuthOptions; pilot: boolean } {
  const raw = sp[PILOT_PARAM];
  return pilotShownOptions(customerAuthService.options(), typeof raw === "string" ? raw : null);
}

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const { options } = shownOptions(await searchParams);
  return { title: "Sign in", description: loginDescription(options), robots: { index: false, follow: true } };
}

const IN_APP = /\b(FBAN|FBAV|FB_IAB|Instagram|Line\/|WhatsApp|Snapchat|TikTok|musical_ly|LinkedInApp|GSA\/)|; wv\)/i;

const LONG_EMAIL = `aleksandra.wisniewska-kowalczyk.bookings.${"x".repeat(150)}@northwind-industries-holdings.example.com`.slice(0, 254);

const PREVIEWS: Record<string, EmailFormPreview> = {
  code: { step: "code", email: "aleksandra@example.com" },
  "code-long": { step: "code", email: LONG_EMAIL },
  "code-invalid": { step: "code", email: "jo@example.com", codeError: "CODE_INVALID" },
  "code-expired": { step: "code", email: "jo@example.com", codeError: "CODE_EXPIRED" },
  "code-locked": { step: "code", email: "jo@example.com", codeError: "RATE_LIMITED" },
  "send-limited": { step: "email", email: LONG_EMAIL, emailError: "RATE_LIMITED" },
  "send-failed": { step: "email", email: "jo@example.com", emailError: "DELIVERY_FAILED" },
  closed: { step: "code", email: "jo@example.com", codeError: "ACCOUNT_CLOSED" },
};

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : null);
  const ua = (await headers()).get("user-agent") ?? "";
  const e = env();
  const dev = e.APP_ENV === "development" && process.env.NODE_ENV !== "production";
  const previewKey = dev ? one("preview") : null;
  const preview = previewKey ? PREVIEWS[previewKey] : undefined;
  const shown = shownOptions(sp);
  let options = shown.options;
  if (dev && one("options")) {
    // Development only: `?options=email,google` or `?options=none` to see each combination.
    const want = new Set((one("options") ?? "").split(","));
    options = { emailCode: want.has("email"), google: want.has("google"), phone: want.has("phone"), turnstileSiteKey: null };
  }

  return (
    <div className="container-page py-8 pb-20">
      <div className="mx-auto grid max-w-4xl gap-8 lg:grid-cols-2 lg:items-center">
        <div className="hidden aspect-[4/3] overflow-hidden rounded-[var(--radius-tile)] lg:block">
          <Scene src="skyline-gold" alt="Dubai skyline at golden hour" />
        </div>
        <div className="min-w-0">
          <Breadcrumbs items={[{ label: "Dubai", href: "/" }, { label: "Sign in" }]} className="mb-3" />
          <div className="max-w-md">
            <LoginClient options={options} next={safeNext(one("next"))} notice={parseLoginNotice(one("e"))} inAppBrowser={IN_APP.test(ua)} preview={preview} pilot={shown.pilot} />
          </div>
        </div>
      </div>
    </div>
  );
}
