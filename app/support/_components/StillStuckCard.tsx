"use client";

import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import { goHref } from "@/lib/dashboard/go";

/**
 * "Still stuck?" (#1527): signed-in visitors open a support request in their
 * own dashboard; everyone else gets the contact form. A client island so the
 * Help Center stays statically rendered — the server and the first client
 * render both show the signed-out card, so hydration always matches.
 */
export function StillStuckCard({
  className,
}: Readonly<{ className?: string }>) {
  const { data: session } = useSession();
  const signedIn = Boolean(session?.user);
  return (
    <Link
      href={signedIn ? goHref("auto", "support") : "/contactus"}
      className={className}
    >
      <p className="font-semibold">Still stuck?</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {signedIn ? "Open a support request" : "Contact us"} — we reply in
        24–48h on business days.
      </p>
    </Link>
  );
}
