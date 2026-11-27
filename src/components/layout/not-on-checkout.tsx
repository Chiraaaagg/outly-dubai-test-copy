"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/** True on /checkout and anything under it: the enclosed checkout (CO-23). */
export function isCheckoutPath(pathname: string | null | undefined): boolean {
  return pathname === "/checkout" || Boolean(pathname?.startsWith("/checkout/"));
}

/**
 * Renders its children everywhere except inside the enclosed checkout, which
 * has no footer sitemap (checkout redesign batch 2, CO-23). Children stay
 * Server Components; only the gate is client-side.
 */
export function NotOnCheckout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (isCheckoutPath(pathname)) return null;
  return <>{children}</>;
}

/** The other half: renders its children only inside the enclosed checkout. */
export function OnlyOnCheckout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (!isCheckoutPath(pathname)) return null;
  return <>{children}</>;
}
