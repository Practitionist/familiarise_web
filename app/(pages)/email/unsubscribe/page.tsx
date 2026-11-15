import type { Metadata } from "next";
import Link from "next/link";
import { MailX } from "lucide-react";
import { BrandWordmark } from "@/components/brand/BrandWordmark";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { goHref } from "@/lib/dashboard/go";
import { verifyEmailUnsubscribeToken } from "@/lib/email/unsubscribe";

export const metadata: Metadata = {
  title: "Email notifications — Familiarise",
  robots: { index: false, follow: false },
};

// The landing page behind the footer's "Unsubscribe" link. The GET that
// brought the reader here flipped nothing (scanners prefetch links); the forms
// POST to the API, which answers a browser with a 303 back here.
type SearchParams = Promise<{
  u?: string | string[];
  t?: string | string[];
  error?: string | string[];
  done?: string | string[];
  resubscribed?: string | string[];
}>;

const OPTIONAL_EMAILS =
  "booking updates and reminders, refunds and payouts, support replies, reviews, and subscription and trial updates";
const REQUIRED_EMAILS =
  "account and security notices, payment receipts, invitations or decisions you must act on, and changes the other person makes to your booking";

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
  const resubscribed = first(params.resubscribed) === "1";
  const signed =
    first(params.error) !== "1" &&
    userId.length > 0 &&
    token.length > 0 &&
    verifyEmailUnsubscribeToken(userId, token);
  const link = `?u=${encodeURIComponent(userId)}&t=${encodeURIComponent(token)}`;
  const title = resubscribed
    ? "Email notifications are back on"
    : done
      ? "Email notifications are off"
      : signed
        ? "Turn off optional email notifications"
        : "This link is not valid";

  return (
    <section className="w-full">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8 flex h-9 items-center justify-center">
          <BrandWordmark size="md" />
        </div>
        <div className="text-center mb-12">
          <div className="flex justify-center mb-4">
            <MailX className="h-16 w-16 text-foreground" />
          </div>
          <h1 className="text-fluid-4xl md:text-fluid-5xl font-bold tracking-tight mb-4">
            Email notifications
          </h1>
        </div>

        <div className="max-w-xl mx-auto">
          <Card className="shadow-elevation-1">
            <CardHeader>
              <CardTitle className="text-fluid-2xl">{title}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {resubscribed && (
                <p className="text-muted-foreground">
                  Optional emails will reach you again, as your notification
                  settings allow.
                </p>
              )}
              {done && !resubscribed && (
                <>
                  <p className="text-muted-foreground">
                    You will no longer receive optional emails:{" "}
                    {OPTIONAL_EMAILS}. Required emails still arrive:{" "}
                    {REQUIRED_EMAILS}.
                  </p>
                  {signed && (
                    <form
                      method="post"
                      action={`/api/notifications/resubscribe${link}`}
                    >
                      <Button type="submit" variant="outline">
                        Resubscribe
                      </Button>
                    </form>
                  )}
                </>
              )}
              {!done && !resubscribed && signed && (
                <>
                  <p className="text-muted-foreground">
                    This stops optional emails for your account:{" "}
                    {OPTIONAL_EMAILS}. Required emails still arrive:{" "}
                    {REQUIRED_EMAILS}. Notifications in the app are not
                    affected.
                  </p>
                  <form
                    method="post"
                    action={`/api/notifications/unsubscribe${link}`}
                  >
                    <Button type="submit" variant="night">
                      Turn off email notifications
                    </Button>
                  </form>
                </>
              )}
              {!done && !resubscribed && !signed && (
                <p className="text-muted-foreground">
                  This link is not valid. It may have been altered on the way
                  here. You can still change what we send you from your
                  Settings.
                </p>
              )}
              <p className="text-sm">
                {/* The go resolver opens the viewer's own Settings ›
                    Notifications, after sign-in if needed. */}
                <Link
                  href={goHref("auto", "settings/notifications")}
                  className="underline underline-offset-4"
                >
                  Manage notification preferences
                </Link>
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
