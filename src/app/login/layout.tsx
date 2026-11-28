import type { Metadata } from "next";

/**
 * Metadata for /login. The description is the page's own (`generateMetadata`
 * in page.tsx): it names Google or an email code only when the page shows
 * them. This fallback names neither.
 */
export const metadata: Metadata = {
  title: "Sign in",
  description: "See your OUTLYY bookings in one place, or find a booking by its reference.",
  robots: { index: false, follow: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
