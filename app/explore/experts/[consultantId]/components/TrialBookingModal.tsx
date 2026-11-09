"use client";

import * as Sentry from "@sentry/nextjs";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { ApiResponseError, requireJsonResponse } from "@/lib/fetch-helpers";
import {
  isExpectedRefusal,
  userMessageFrom,
} from "@/lib/errors/client-refusal";
import { z } from "zod";
import { useBuyerPrice } from "@/components/pricing/BuyerPriceProvider";
import {
  buyerDisplayPricePaise,
  withBuyerPriceNote,
} from "@/lib/payments/pricing/display-price";
import { formatCurrencyAmount } from "@/utils/formatting";
import { FREE_TRIAL_LABEL } from "@/lib/appointments/trial-labels";
import { leadMsFor } from "@/lib/booking/lead-time";
import { invalidateAvailability } from "@/lib/scheduling/use-availability-window";
import type { SlotWithStatus } from "@/lib/scheduling/booking-windows";
import { useDisplayZone } from "@/lib/time/use-display-zone";
import { TrialSlotPicker } from "./TrialSlotPicker";
import { Gift, Clock, Loader2, CheckCircle } from "lucide-react";

const profileAnswerSchema = z.object({
  data: z.object({ id: z.string() }).nullish(),
});
const eligibilityAnswerSchema = z.object({
  data: z.object({
    isEligible: z.boolean(),
    reason: z.string().nullish(),
  }),
});
const createdAnswerSchema = z.object({
  checkoutUrl: z.string().nullish(),
});

interface TrialBookingModalProps {
  isOpen: boolean;
  onClose: () => void;
  consultantProfileId: string;
  consultantName: string;
  subscriptionPlanId: string;
  planTitle: string;
  trialDurationMinutes: number;
  /** #1167 — 0 is a genuinely free trial; anything above is charged. */
  trialPriceInPaise?: number;
  /** The plan's own currency. Trials have no separate one. */
  trialCurrency?: string;
}

export function TrialBookingModal({
  isOpen,
  onClose,
  consultantProfileId,
  consultantName,
  subscriptionPlanId,
  planTitle,
  trialDurationMinutes,
  trialPriceInPaise = 0,
  trialCurrency = "INR",
}: Readonly<TrialBookingModalProps>) {
  const isPaidTrial = trialPriceInPaise > 0;
  const { gstRegistered } = useBuyerPrice();
  const priceLabel = isPaidTrial
    ? withBuyerPriceNote(
        formatCurrencyAmount(
          buyerDisplayPricePaise(trialPriceInPaise, gstRegistered),
          trialCurrency,
        ),
        trialPriceInPaise,
        gstRegistered,
      )
    : FREE_TRIAL_LABEL;
  const { data: session } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const zone = useDisplayZone(session?.user?.timezone ?? null);
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<SlotWithStatus | null>(null);
  // A paid trial is paid after this request, so it needs the unpaid lead.
  const leadMs = leadMsFor("request", { settled: !isPaidTrial });

  // Send an unauthenticated visitor to sign-in, preserving the trial intent so
  // that after auth + onboarding they land back on this expert with the trial
  // modal auto-opened (the expert page honours ?action=trial).
  // Memoized so the guest CTA can render as a prefetchable <Link>; the
  // programmatic redirect below pushes the identical URL.
  const signInHref = useMemo(() => {
    const returnTo = `${pathname}?action=trial`;
    return `/auth/signin?callbackUrl=${encodeURIComponent(returnTo)}`;
  }, [pathname]);

  const redirectToSignIn = () => {
    router.push(signInHref);
  };

  const handleSubmit = async () => {
    if (!session?.user?.id) {
      redirectToSignIn();
      return;
    }
    if (!selectedSlot) {
      toast({ title: "Pick a time first", variant: "destructive" });
      return;
    }

    try {
      setIsSubmitting(true);

      // First, get the consultee profile ID
      // A 404 is the modelled "no learner profile yet" answer.
      const profileResponse = await fetch(
        `/api/profiles/consultee?userId=${session.user.id}`,
      );
      const profileBody =
        profileResponse.status === 404
          ? null
          : profileAnswerSchema.safeParse(
              await requireJsonResponse(
                profileResponse,
                "Profile lookup failed",
              ),
            );
      const consulteeProfileId = profileBody?.success
        ? profileBody.data.data?.id
        : undefined;

      if (!consulteeProfileId) {
        toast({
          title: "Finish your profile first",
          description:
            "You need a learner profile to request a trial. Complete your profile setup, then try again.",
          variant: "destructive",
        });
        return;
      }

      // Check eligibility
      const eligibilityBody = eligibilityAnswerSchema.parse(
        await requireJsonResponse(
          await fetch(
            `/api/trials/check-eligibility?consulteeProfileId=${consulteeProfileId}&consultantProfileId=${consultantProfileId}&subscriptionPlanId=${subscriptionPlanId}`,
          ),
          "Eligibility check failed",
        ),
      );
      const eligibility = eligibilityBody.data;

      if (!eligibility.isEligible) {
        toast({
          title: "Not Eligible",
          description:
            eligibility.reason ||
            "You are not eligible for a trial with this consultant",
          variant: "destructive",
        });
        return;
      }

      // Submit trial request
      const response = await fetch("/api/trials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consulteeProfileId,
          consultantProfileId,
          subscriptionPlanId,
          notes: notes.trim() || undefined,
          slot: {
            startsAt: new Date(selectedSlot.startsAt).toISOString(),
            endsAt: new Date(selectedSlot.endsAt).toISOString(),
          },
        }),
      });

      // A paid trial holds the time while the buyer pays: straight to checkout.
      const createdBody = createdAnswerSchema.safeParse(
        await requireJsonResponse(response, "Trial request failed"),
      );
      const created = createdBody.success ? createdBody.data : {};
      if (created.checkoutUrl) {
        router.push(created.checkoutUrl);
        return;
      }

      setIsSuccess(true);
      toast({
        title: "Trial booked",
        description: `Your trial with ${consultantName} is confirmed. It's in your appointments.`,
      });
      void invalidateAvailability(queryClient, consultantProfileId);

      // Auto close after success
      setTimeout(() => {
        onClose();
        setIsSuccess(false);
        setNotes("");
        setSelectedSlot(null);
      }, 2000);
    } catch (error) {
      console.warn("Trial request failed", error);
      // A modelled refusal is an answer, not a fault: it carries a sentence
      // written for the buyer and is not a Sentry event.
      const expected = isExpectedRefusal(error);
      // The time went while the buyer was choosing: drop it and re-read.
      if (
        error instanceof ApiResponseError &&
        (error.status === 409 || error.status === 423 || error.status === 400)
      ) {
        setSelectedSlot(null);
        void invalidateAvailability(queryClient, consultantProfileId);
      }
      if (!expected) {
        Sentry.captureException(
          error instanceof Error ? error : new Error(String(error)),
          { tags: { subsystem: "client", flow: "trial-request" } },
        );
      }
      toast({
        title: "Couldn't book the trial",
        description:
          expected && error instanceof ApiResponseError && error.code
            ? userMessageFrom(error)
            : "Please try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!session?.user?.id) {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Gift className="h-5 w-5 text-emerald-500" />
              Book Trial
            </DialogTitle>
            <DialogDescription>
              Sign in to request a trial session
            </DialogDescription>
          </DialogHeader>
          <div className="py-6 text-center">
            <p className="text-muted-foreground mb-4">
              Please sign in to request a trial with {consultantName}
            </p>
            <Button asChild>
              <Link href={signInHref} prefetch>
                Sign In to Continue
              </Link>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (isSuccess) {
    return (
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-[425px]">
          <div className="py-8 text-center">
            <div className="mx-auto w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mb-4">
              <CheckCircle className="h-8 w-8 text-emerald-600" />
            </div>
            <h3 className="text-xl font-semibold text-foreground mb-2">
              Trial booked
            </h3>
            <p className="text-muted-foreground">
              Your trial with {consultantName} is confirmed. Find it in your
              appointments.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gift className="h-5 w-5 text-emerald-500" />
            Book Trial Session
          </DialogTitle>
          <DialogDescription>
            Pick a time for a {trialDurationMinutes}-minute trial with{" "}
            {consultantName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Plan Info — the price is the first thing shown. Requesting a
              trial used to name no number anywhere, so a paid trial read as
              free right up until the payment link arrived. */}
          <div className="bg-muted rounded-lg p-4">
            <p className="text-sm font-medium text-foreground">{planTitle}</p>
            <div className="flex items-center justify-between gap-3 mt-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-4 w-4" />
                <span>{trialDurationMinutes} minute trial</span>
              </div>
              <span
                className={`text-sm font-semibold ${
                  isPaidTrial ? "text-foreground" : "text-emerald-600"
                }`}
              >
                {priceLabel}
              </span>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Pick a time</Label>
            <TrialSlotPicker
              consultantId={consultantProfileId}
              consulteeUserId={session.user.id}
              trialDurationMinutes={trialDurationMinutes}
              leadMs={leadMs}
              timezone={zone.zone}
              selected={selectedSlot}
              onSelect={setSelectedSlot}
            />
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <Label htmlFor="notes">
              What would you like to discuss? (Optional)
            </Label>
            <Textarea
              id="notes"
              placeholder="Share your goals, questions, or topics you'd like to cover in the trial session..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="min-h-[100px]"
            />
            <p className="text-xs text-muted-foreground">
              This helps the consultant prepare for your session
            </p>
          </div>

          {/* Say when money changes hands and what confirms the time. */}
          <div className="bg-muted rounded-lg p-4 text-sm text-muted-foreground">
            {isPaidTrial ? (
              <p>
                You pay{" "}
                <strong className="text-foreground">{priceLabel}</strong> next.
                The time is held for you while you pay, and confirmed as soon as
                the payment goes through.
              </p>
            ) : (
              <p>Your trial is confirmed as soon as you book it.</p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || !selectedSlot}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Booking...
              </>
            ) : (
              <>
                <Gift className="h-4 w-4 mr-2" />
                {isPaidTrial ? "Continue to payment" : "Book trial"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
