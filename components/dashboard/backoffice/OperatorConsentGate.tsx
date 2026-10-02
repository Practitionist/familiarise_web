"use client";

import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";

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
import {
  PURPOSE_CODE_META,
  SIGNUP_PURPOSES,
} from "@/lib/compliance/purpose-codes";

/**
 * The operator's first-sign-in consent step (lib/compliance/
 * operator-consent.ts). Rendered by the back-office layout only while the
 * operator has no core-processing artifact; not dismissable, because the
 * consent-gated features (video, chat) fail closed without it.
 */
export function OperatorConsentGate() {
  const router = useRouter();
  const grant = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/user/consent", { method: "POST" });
      if (!res.ok) throw new Error("We couldn't save your consent. Try again.");
    },
    onSuccess: () => router.refresh(),
  });

  return (
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Before you start</AlertDialogTitle>
          <AlertDialogDescription>
            To use Familiarise as a member of staff, we need your consent to
            process your personal data for these purposes.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="space-y-2 text-sm">
          {SIGNUP_PURPOSES.map((code) => (
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
          <Button onClick={() => grant.mutate()} disabled={grant.isPending}>
            {grant.isPending ? "Saving…" : "I agree"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
