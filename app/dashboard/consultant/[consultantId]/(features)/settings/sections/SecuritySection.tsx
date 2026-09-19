"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * Security tab of the consultant settings page (Q5 minimal).
 *
 * No new API: password change lives at /settings/change-password and session /
 * connected-account management at /profile. This tab consolidates the links so
 * security controls are discoverable from settings instead of only via direct
 * URL. Full inline 2FA/passkey management is a follow-up.
 */
export function SecuritySection() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Password</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <p className="text-xs text-zinc-500">
            Change the password used to sign in to your account.
          </p>
          <Button asChild variant="outline">
            <Link href="/settings/change-password">Change password</Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Sessions & connected accounts</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <p className="text-xs text-zinc-500">
            Review connected social accounts, revoke other sessions, or delete
            your account.
          </p>
          <Button asChild variant="outline">
            <Link href="/profile">Manage in Profile</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
