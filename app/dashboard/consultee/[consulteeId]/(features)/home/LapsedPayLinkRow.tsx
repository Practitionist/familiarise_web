import Link from "next/link";
import { format } from "date-fns";
import { LinkIcon } from "lucide-react";
import type { LapsedPayLink } from "@/lib/dashboard/lapsed-pay-links";

/**
 * #1675 — one lapsed pay-link, muted, with the single way forward. Pure so the
 * copy and the link can be pinned without the widget's query plumbing.
 */
export function LapsedPayLinkRow({ link }: { link: LapsedPayLink }) {
  return (
    <div className="px-5 py-3.5" data-testid="lapsed-pay-link">
      <p className="text-sm text-muted-foreground">
        <LinkIcon className="inline h-3 w-3 mr-1 align-[-1px]" aria-hidden />
        Your payment link for {link.consultantName} expired on{" "}
        {format(new Date(link.expiredAt), "d MMM yyyy")}. Ask{" "}
        {link.consultantName} for a new link, or book another time.
      </p>
      <p className="text-xs text-muted-foreground/70 mt-0.5 truncate">
        {link.title}
      </p>
      <Link
        href={link.requestAgainHref}
        className="inline-block mt-2 text-xs font-semibold text-foreground underline underline-offset-4 hover:text-muted-foreground"
      >
        Request again
      </Link>
    </div>
  );
}
