import type { Metadata } from "next";
import { TicketLinkLanding } from "./ticket-link";

export const metadata: Metadata = {
  title: "Open your booking",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * `/t` — the landing page of the booking link we email (doc 22 §26 F39,
 * R-B4-11, TKT-5). The link is `/t#<token>`: the token is in the URL
 * fragment, which browsers never send to a server, so this response is the
 * same static page for everyone and contains nothing about any order.
 *
 * Nothing happens on load. A mail scanner or link preview that fetches this
 * page, or even runs its script, consumes nothing: the token is exchanged
 * only when a person presses "Open my booking" (see `TicketLinkLanding`).
 * No analytics run here.
 */
export default function TicketLinkPage() {
  return (
    <div className="container-page py-10 pb-20">
      <TicketLinkLanding />
    </div>
  );
}
