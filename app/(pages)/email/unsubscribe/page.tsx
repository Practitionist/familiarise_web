import type { Metadata } from "next";
import Link from "next/link";
import { MailX } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { verifyEmailUnsubscribeToken } from "@/lib/email/unsubscribe";

export const metadata: Metadata = {
  title: "Email notifications — Familiarise",
  robots: { index: false, follow: false },
};

// #1653 — the landing page behind the footer's "Unsubscribe" link. The GET
// that brought the reader here flipped nothing (scanners prefetch links); the
// form below POSTs to the API, which answers a browser with a 303 back to
// `?done=1`.
type SearchParams = Promise<{
  u?: string | string[];
  t?: string | string[];
  error?: string | string[];
  done?: string | string[];
}>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function EmailUnsubscribePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const userId = first(params.u);
  const token = first(params.t);
  const done = first(params.done) === "1";
  const valid =
    !done &&
    first(params.error) !== "1" &&
    userId.length > 0 &&
    token.length > 0 &&
    verifyEmailUnsubscribeToken(userId, token);
  const action = `/api/notifications/unsubscribe?u=${encodeURIComponent(
    userId,
  )}&t=${encodeURIComponent(token)}`;

  return (
    <section className="w-full py-12 md:py-16">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <div className="max-w-xl mx-auto">
          <div className="mb-8">
            <div className="flex flex-wrap items-center gap-2.5 mb-4">
              <Badge variant="secondary" className="gap-1.5">
                <MailX className="h-3.5 w-3.5" />
                Account Preferences
              </Badge>
            </div>
            <h1 className="text-fluid-3xl md:text-fluid-4xl font-bold tracking-tight mb-2">
              Email notifications
            </h1>
            <p className="text-fluid-base text-muted-foreground">
              Manage how Familiarise contacts you by email.
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-card p-6 md:p-10 shadow-elevation-1 space-y-6">
            <h2 className="text-fluid-2xl font-semibold tracking-tight">
              {done
                ? "Done"
                : valid
                  ? "Turn off optional email notifications"
                  : "This link is not valid"}
            </h2>
            {done && (
              <p className="text-muted-foreground">
                Done — you will not receive optional email notifications.
                Required account notices still arrive.
              </p>
            )}
            {!done && valid && (
              <>
                <p className="text-muted-foreground leading-relaxed">
                  This turns off all optional email notifications for your
                  account, such as booking updates, receipts and reminders.
                  Required account notices, like a security alert or an
                  invitation you must answer, still arrive. Notifications in
                  the app are not affected.
                </p>
                <form method="post" action={action}>
                  <Button type="submit" variant="night">
                    Turn off email notifications
                  </Button>
                </form>
              </>
            )}
            {!done && !valid && (
              <p className="text-muted-foreground leading-relaxed">
                This link is not valid. It may have been altered on the way
                here. You can still change what we send you from your
                Settings.
              </p>
            )}
            <p className="text-sm pt-2 border-t border-border">
              {/* #1527 — /profile routes each viewer to their own
                  Settings › Notifications (after sign-in if needed). */}
              <Link
                href="/profile?section=notifications"
                className="font-medium underline underline-offset-4 hover:text-foreground"
              >
                Manage notification preferences in Settings
              </Link>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
