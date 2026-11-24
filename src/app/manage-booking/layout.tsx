import type { Metadata } from "next";

/** Client-rendered route — metadata lives in this layout instead of the page. */
export const metadata: Metadata = {
  title: "Find your booking",
  description: "Look up an OUTLYY booking with its reference and the phone number or email you booked with. No account needed.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
