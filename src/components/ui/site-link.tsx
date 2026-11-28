"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentProps } from "react";
import { isPrivateCustomerPath } from "@/lib/customer-status";

/**
 * `next/link` for the shared chrome (header, footer, cookie banner, logo,
 * breadcrumbs, `ButtonLink`) that never prefetches while the visitor is on a
 * private customer page (`PRIVATE_CUSTOMER_ROUTE_PREFIXES`: `/t`, `/booking`,
 * `/manage-booking`, `/voucher`).
 *
 * A production prefetch pulls the target route's RSC payload, and React
 * applies its resource hints at once: the home page's hero photo is preloaded
 * from images.pexels.com while the visitor is still on a ticket or booking
 * page. Private pages must not talk to another origin (B5 browser check,
 * doc 22 §32.10), so prefetching is off there. Everywhere else the caller's
 * `prefetch` (or Next's default) applies.
 */
export function SiteLink({ prefetch, ...rest }: ComponentProps<typeof Link>) {
  const pathname = usePathname();
  const isPrivate = pathname ? isPrivateCustomerPath(pathname) : false;
  return <Link {...rest} prefetch={isPrivate ? false : prefetch} />;
}
