"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { fetchWithIdentity } from "@/lib/auth/identity-header";

const ORG_ID = /^[A-Za-z0-9_-]+$/;

/** The "this wasn't me" link lands here; rendering freezes nothing, the button does. */
export default function FreezePayoutsPage() {
  const org = useSearchParams().get("org");
  const orgId = org && ORG_ID.test(org) ? org : null;
  const [done, setDone] = useState(false);
  const freeze = useMutation({
    mutationFn: async () => {
      const url = orgId
        ? `/api/organizations/${orgId}/payout-account/freeze`
        : "/api/consultant/payout-accounts/freeze";
      const res = await fetchWithIdentity(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) throw new Error("Payouts were not frozen.");
    },
    onSuccess: () => setDone(true),
  });

  return (
    <div className="mx-auto max-w-lg p-6">
      <Card>
        <CardHeader>
          <CardTitle>Freeze payouts?</CardTitle>
          <CardDescription>
            Your payout bank account was changed. If this wasn&apos;t you,
            freeze payouts so no money is sent until support has checked the
            account.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {done ? (
            <p className="text-sm">
              Payouts are frozen. Contact support to lift the freeze.
            </p>
          ) : (
            <Button
              variant="destructive"
              disabled={freeze.isPending}
              onClick={() => freeze.mutate()}
            >
              Freeze payouts
            </Button>
          )}
          {freeze.isError && (
            <p className="text-sm text-destructive">
              {freeze.error.message} Try again or contact support.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
