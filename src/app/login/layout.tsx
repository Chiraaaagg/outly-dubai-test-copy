import type { Metadata } from "next";

/** Metadata for /login (the page itself is a dynamic server component). */
export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to see your OUTLYY bookings: Google or a one-time code by email. No password needed.",
  robots: { index: false, follow: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
