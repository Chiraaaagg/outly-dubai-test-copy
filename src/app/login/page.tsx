import { headers } from "next/headers";
import { Breadcrumbs } from "@/components/ui/primitives";
import { Scene } from "@/components/ui/scene";
import { customerAuthService } from "@/server/services/customer-auth.service";
import { env } from "@/server/lib/env";
import { parseLoginNotice } from "@/lib/customer-auth-options";
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
 */

export const dynamic = "force-dynamic";

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

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : null);
  const ua = (await headers()).get("user-agent") ?? "";
  const e = env();
  const dev = e.APP_ENV === "development" && process.env.NODE_ENV !== "production";
  const previewKey = dev ? one("preview") : null;
  const preview = previewKey ? PREVIEWS[previewKey] : undefined;
  let options = customerAuthService.options();
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
            <LoginClient options={options} next={safeNext(one("next"))} notice={parseLoginNotice(one("e"))} inAppBrowser={IN_APP.test(ua)} preview={preview} />
          </div>
        </div>
      </div>
    </div>
  );
}
