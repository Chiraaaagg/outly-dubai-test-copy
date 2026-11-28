import type { Metadata } from "next";

/** Client-rendered route — metadata lives in this layout instead of the page. */
export const metadata: Metadata = {
  title: "Checkout",
  description: "Guest checkout by card. All-in pricing with nothing added at this step.",
  robots: { index: false, follow: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
