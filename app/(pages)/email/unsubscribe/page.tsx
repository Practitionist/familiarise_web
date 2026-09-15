import type { Metadata } from "next";
import Link from "next/link";
import { MailX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    <section className="w-full">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8 py-8">
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
              <CardTitle className="text-fluid-2xl">
                {done
                  ? "Done"
                  : valid
                    ? "Turn off optional email notifications"
                    : "This link is not valid"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {done && (
                <p className="text-muted-foreground">
                  Done — you will not receive optional email notifications.
                  Required account notices still arrive.
                </p>
              )}
              {!done && valid && (
                <>
                  <p className="text-muted-foreground">
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
                <p className="text-muted-foreground">
                  This link is not valid. It may have been altered on the way
                  here. You can still change what we send you from your profile.
                </p>
              )}
              <p className="text-sm">
                <Link href="/profile" className="underline underline-offset-4">
                  Manage preferences on your profile
                </Link>
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
