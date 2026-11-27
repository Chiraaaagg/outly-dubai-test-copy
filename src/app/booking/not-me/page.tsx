import type { Metadata } from "next";
import { NotMeLanding } from "./not-me-client";

export const metadata: Metadata = {
  title: "This was not me",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * `/booking/not-me#<token>` — the "This was not me" link of the notice we
 * email when a booking is added to an account automatically (Group B, owner
 * Q10, Q-B4). The token is in the fragment, so this page is the same for
 * everyone and names no order. Nothing happens on load; a person presses the
 * button. Under /booking, so never cached, indexed or referred on.
 */
export default function NotMePage() {
  return (
    <div className="container-page py-10 pb-20">
      <NotMeLanding />
    </div>
  );
}
