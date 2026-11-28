import type { Metadata } from "next";

/** Client-rendered route — metadata lives in this layout instead of the page. */
export const metadata: Metadata = {
  title: "Contact OUTLYY",
  description: "Contact OUTLYY about an existing booking, a group trip, an invoice or a supplier inquiry.",
  robots: { index: true, follow: true },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
