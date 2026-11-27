import type { Metadata } from "next";

/** Client-rendered route — metadata lives in this layout instead of the page. */
export const metadata: Metadata = {
  title: "Your booking",
  description: "The status of your booking, checked with our system.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
