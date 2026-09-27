"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field-error";
import { useSession } from "@/lib/auth-client";
import { dataConsentHref } from "@/lib/dashboard/account-href";
import {
  PURPOSE_CODES,
  PURPOSE_CODE_META,
  normalizePurposeCode,
} from "@/lib/compliance/purpose-codes";

/**
 * The purposes a signup grants (lib/auth.ts user.create hook). A member who
 * joined through SSO JIT or SCIM was never shown them, so this step asks.
 */
const JOIN_PURPOSES = [
  PURPOSE_CODES.PRIMARY_PROCESSING,
  PURPOSE_CODES.STREAM_DATA_PROCESSING,
  PURPOSE_CODES.SESSION_BOOKING,
] as const;

interface Artifact {
  purposeCodes: string[];
}

/**
 * #1846 bucket C rule 3 — SSO JIT and SCIM stay automatic because the
 * employer's IdP vouches for the person, but the member's first sign-in shows
 * the DPDP consent step. It reuses the user-level consent record, so no
 * schema: the step shows only while the member has NO core-processing
 * artifact at all, granted or withdrawn. Someone who withdrew later is not
 * nagged here; Account › Data consent is where they change their mind.
 */
export function JoinConsentGate({
  orgId,
  orgName,
}: Readonly<{ orgId: string; orgName: string }>) {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const queryKey = ["org-join-consent", orgId];

  const { data: neverAsked } = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/consent?limit=200`);
      // Fail open: a failed read must not lock anyone out of the dashboard.
      if (!res.ok) return false;
      const body = (await res.json()) as { data: Artifact[] };
      return !body.data.some((a) =>
        a.purposeCodes.some(
          (c) => normalizePurposeCode(c) === PURPOSE_CODES.PRIMARY_PROCESSING,
        ),
      );
    },
    enabled: !!session?.user?.id,
    staleTime: Infinity,
  });

  const grant = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purposeCodes: JOIN_PURPOSES,
          language: "en-IN",
          version: 1,
        }),
      });
      if (!res.ok) throw new Error("We couldn't save your consent. Try again.");
    },
    onSuccess: () => {
      queryClient.setQueryData(queryKey, false);
      void queryClient.invalidateQueries({ queryKey: ["account-org-consent"] });
    },
  });

  const reviewHref = session?.user ? dataConsentHref(session.user) : null;

  return (
    <AlertDialog open={neverAsked === true}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Before you start with {orgName}</AlertDialogTitle>
          <AlertDialogDescription>
            {orgName} added you through your company sign-in. To use
            Familiarise, we need your consent to process your data for these
            purposes. You can withdraw it at any time in Account › Data consent.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="space-y-2 text-sm">
          {JOIN_PURPOSES.map((code) => (
            <li key={code}>
              <p className="font-medium text-foreground">
                {PURPOSE_CODE_META[code].label}
              </p>
              <p className="text-muted-foreground">
                {PURPOSE_CODE_META[code].description}
              </p>
            </li>
          ))}
        </ul>
        <FieldError message={grant.error?.message ?? null} />
        <AlertDialogFooter>
          {reviewHref && (
            <Button variant="outline" asChild>
              <Link href={reviewHref}>Review each purpose</Link>
            </Button>
          )}
          <Button onClick={() => grant.mutate()} disabled={grant.isPending}>
            {grant.isPending ? "Saving…" : "I agree"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
