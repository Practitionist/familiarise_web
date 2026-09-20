"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { QrCode } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";

import {
  pollReversePennyDrop,
  startReversePennyDrop,
  type ReversePennyDropStartView,
} from "./get-paid-api";
import {
  usePayoutSetupInvalidation,
  useRefusalToast,
} from "./PayoutAccountForm";

/** RazorpayX completes within seconds of the UPI payment; poll gently, give up politely. */
const POLL_MS = 3_000;
const POLL_LIMIT_MS = 5 * 60_000;

type Phase =
  | { kind: "idle" }
  | { kind: "waiting"; start: ReversePennyDropStartView; since: number }
  | { kind: "failed"; reason: string }
  | { kind: "verified" };

const APP_LINKS: Array<[keyof ReversePennyDropStartView["upiIntent"], string]> =
  [
    ["gpayUrl", "Google Pay"],
    ["phonepeUrl", "PhonePe"],
    ["paytmUrl", "Paytm"],
    ["bhimUrl", "BHIM"],
    ["intentUrl", "Any UPI app"],
  ];

/**
 * "Verify with ₹1 from your UPI app" — the reverse penny drop. We mint the
 * intent, show the QR and the app links, and poll the settle route until
 * RazorpayX has seen the rupee. The bank details never reach this component:
 * the server persists the masked row and this only learns "verified".
 */
export function ReversePennyDrop({
  consultantId,
  disabled = false,
  onVerified,
}: Readonly<{
  consultantId: string;
  disabled?: boolean;
  onVerified?: () => void;
}>) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const invalidate = usePayoutSetupInvalidation(consultantId);
  const refusalToast = useRefusalToast();
  const { toast } = useToast();
  const onVerifiedRef = useRef(onVerified);
  onVerifiedRef.current = onVerified;

  const start = useMutation({
    mutationFn: startReversePennyDrop,
    onSuccess: (started) =>
      setPhase({ kind: "waiting", start: started, since: Date.now() }),
    onError: (error) =>
      refusalToast(error, "Could not start the ₹1 verification."),
  });

  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const { validationId } = phase.start;
    let cancelled = false;
    const timer = setInterval(async () => {
      if (Date.now() - phase.since > POLL_LIMIT_MS) {
        clearInterval(timer);
        setPhase({
          kind: "failed",
          reason:
            "We did not see the ₹1 arrive. Start again when you are ready.",
        });
        return;
      }
      try {
        const outcome = await pollReversePennyDrop(validationId);
        if (cancelled || outcome.status === "pending") return;
        clearInterval(timer);
        if (outcome.status === "failed") {
          setPhase({ kind: "failed", reason: outcome.reason });
          return;
        }
        setPhase({ kind: "verified" });
        await invalidate();
        toast({
          title: "Account verified",
          description: `Payouts will go to •••• ${outcome.account.accountNumberLast4 ?? ""}.`,
        });
        onVerifiedRef.current?.();
      } catch {
        // A transient poll failure is not an answer; the next tick retries.
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // `invalidate`/`toast` are stable enough for this effect's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  if (phase.kind === "verified") {
    return (
      <p className="text-sm text-emerald-700">
        Verified — the ₹1 is already on its way back to you.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">Verify with ₹1 from your UPI app</p>
        <p className="text-xs text-muted-foreground">
          Pay ₹1 from the account you want paid into; the bank tells us the
          account and refunds the rupee straight away. Fastest, and no typing.
        </p>
      </div>

      {phase.kind === "failed" && (
        <p role="alert" className="text-sm text-amber-700">
          {phase.reason}
        </p>
      )}

      {phase.kind === "waiting" ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          {phase.start.upiIntent.encodedQrCode && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`data:image/png;base64,${phase.start.upiIntent.encodedQrCode}`}
              alt="Scan with any UPI app to pay ₹1"
              width={160}
              height={160}
              className="rounded-lg border border-border bg-white p-1"
            />
          )}
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              Waiting for the ₹1… this updates by itself.
            </p>
            <div className="flex flex-wrap gap-2">
              {APP_LINKS.map(([key, label]) => {
                const href = phase.start.upiIntent[key];
                return href ? (
                  <Button key={key} asChild variant="outline" size="sm">
                    <a href={href}>{label}</a>
                  </Button>
                ) : null;
              })}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPhase({ kind: "idle" })}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          onClick={() => start.mutate()}
          disabled={disabled || start.isPending}
        >
          <QrCode className="mr-2 h-4 w-4" aria-hidden />
          {start.isPending ? "Preparing…" : "Show the ₹1 request"}
        </Button>
      )}
    </div>
  );
}
