import type { Metadata } from "next";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  CheckCircle2,
  MailX,
  ShieldAlert,
  SlidersHorizontal,
} from "lucide-react";
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
}: Readonly<{
  searchParams: SearchParams;
}>) {
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

  let headingText = "This link is not valid";
  let statusBadgeLabel = "Invalid or Expired Link";
  let StatusIcon = AlertTriangle;
  if (done) {
    headingText = "Done";
    statusBadgeLabel = "Preferences Updated";
    StatusIcon = CheckCircle2;
  } else if (valid) {
    headingText = "Turn off optional email notifications";
    statusBadgeLabel = "Confirm Unsubscribe";
    StatusIcon = MailX;
  }

  return (
    <main className="min-h-screen w-full bg-background">
      {/* Full-Bleed Dark Hero */}
      <section className="relative overflow-hidden bg-zinc-950 text-white pt-32 pb-20 md:pb-24">
        <div className="grid-pattern pointer-events-none absolute inset-0 opacity-20" />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-0 h-[420px] w-[760px] -translate-x-1/2 bg-[radial-gradient(closest-side,rgba(255,255,255,0.08),transparent)]"
        />

        <div className="container relative z-10 mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-zinc-700/60 bg-zinc-900/80 px-4 py-1.5 text-sm text-zinc-300 backdrop-blur-sm">
            <MailX className="h-4 w-4 text-zinc-300" aria-hidden="true" />
            <span>Account Preferences</span>
          </div>
          <h1 className="text-fluid-4xl md:text-fluid-5xl mb-4 font-bold tracking-tight">
            <span>Email </span>
            <span className="silver-text">notifications</span>
          </h1>
          <p className="mx-auto max-w-xl text-base leading-relaxed text-zinc-400 md:text-lg">
            Manage how Familiarise contacts you by email.
          </p>
        </div>
      </section>

      {/* Main Confirmation Card */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl mx-auto rounded-2xl border border-border bg-card p-6 md:p-10 shadow-elevation-1 space-y-8">
            <div className="flex flex-col sm:flex-row sm:items-start gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-zinc-950 text-white dark:bg-white dark:text-zinc-950">
                <StatusIcon className="h-6 w-6" aria-hidden="true" />
              </div>
              <div className="space-y-2">
                <Badge variant="secondary" className="text-xs">
                  {statusBadgeLabel}
                </Badge>
                <h2 className="text-fluid-2xl font-bold tracking-tight text-foreground">
                  {headingText}
                </h2>
                {done && (
                  <p className="text-muted-foreground leading-relaxed">
                    Done — you will not receive optional email notifications.
                    Required account notices still arrive.
                  </p>
                )}
                {!done && valid && (
                  <p className="text-muted-foreground leading-relaxed">
                    This turns off all optional email notifications for your
                    account, such as booking updates, receipts and reminders.
                    Required account notices, like a security alert or an
                    invitation you must answer, still arrive. Notifications in
                    the app are not affected.
                  </p>
                )}
                {!done && !valid && (
                  <p className="text-muted-foreground leading-relaxed">
                    This link is not valid. It may have been altered on the way
                    here. You can still change what we send you from your
                    Settings.
                  </p>
                )}
              </div>
            </div>

            {/* 2-Column Comparison Box */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-border bg-muted/40 p-5 space-y-2.5">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Bell
                    className="h-4 w-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span>What this turns off</span>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Optional email notifications including booking updates,
                  appointment reminders, feedback requests, and marketing
                  digests.
                </p>
              </div>

              <div className="rounded-xl border border-border bg-muted/40 p-5 space-y-2.5">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <ShieldAlert
                    className="h-4 w-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span>What still arrives</span>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Essential security alerts, sign-in verifications, and
                  invitations that require your response. In-app notifications
                  remain active.
                </p>
              </div>
            </div>

            {/* Primary & Secondary Actions */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-4 border-t border-border">
              {!done && valid ? (
                <form method="post" action={action}>
                  <Button type="submit" variant="night" size="lg">
                    Turn off email notifications
                  </Button>
                </form>
              ) : (
                <Button asChild variant="outline" size="lg">
                  <Link href="/">
                    <span>Return to Home</span>
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              )}

              <p className="text-sm">
                {/* #1527 — /profile routes each viewer to their own
                    Settings › Notifications (after sign-in if needed). */}
                <Link
                  href="/profile?section=notifications"
                  className="inline-flex items-center gap-1.5 font-medium text-foreground underline underline-offset-4 hover:no-underline"
                >
                  <SlidersHorizontal
                    className="h-3.5 w-3.5"
                    aria-hidden="true"
                  />
                  <span>Manage notification preferences in Settings</span>
                </Link>
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
