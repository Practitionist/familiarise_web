"use client";

import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import { goHref } from "@/lib/dashboard/go";
import { ACK_PROMISE_COPY } from "@/app/(pages)/constants";

/**
 * Signed-in visitors open a support request in their own dashboard; everyone
 * else gets the contact form.
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
        {signedIn ? "Open a support request" : "Contact us"} — we acknowledge{" "}
        {ACK_PROMISE_COPY}.
      </p>
    </Link>
  );
}
