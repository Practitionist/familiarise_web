"use client";

import * as Sentry from "@sentry/nextjs";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CheckCircle, Clock, Gift, Loader2 } from "lucide-react";
import { z } from "zod";

import { useBuyerPrice } from "@/components/pricing/BuyerPriceProvider";
import {
  SingleTimePicker,
  type SingleTimeValue,
} from "@/components/scheduling/SingleTimePicker";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { FREE_TRIAL_LABEL } from "@/lib/appointments/trial-labels";
import { useSession } from "@/lib/auth-client";
import { trialCreateBody } from "@/lib/booking/picked-time";
import {
  isExpectedRefusal,
  userMessageFrom,
} from "@/lib/errors/client-refusal";
import { ApiResponseError, requireJsonResponse } from "@/lib/fetch-helpers";
import {
  buyerDisplayPricePaise,
  withBuyerPriceNote,
} from "@/lib/payments/pricing/display-price";
import { invalidateAvailability } from "@/lib/scheduling/use-availability-window";
import { formatDateTimeLabel } from "@/lib/time/display";
import { formatCurrencyAmount } from "@/utils/formatting";

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
const rateLimitedBodySchema = z.object({ retryAt: z.string().datetime() });

/** When a 429 lets the buyer try again: the body's `retryAt`, else `Retry-After`. */
function retryInstantOf(error: ApiResponseError): Date | null {
  const parsed = rateLimitedBodySchema.safeParse(error.body);
  if (parsed.success) return new Date(parsed.data.retryAt);
  return error.retryAfterMs === undefined
    ? null
    : new Date(Date.now() + error.retryAfterMs);
}

export interface MentorshipTrialStepProps {
  consultantProfileId: string;
  consultantName: string;
  subscriptionPlanId: string;
  planTitle: string;
  trialDurationMinutes: number;
  /** 0 is a free trial; anything above is charged. */
  trialPriceInPaise: number;
  /** The plan's own currency; a trial has none of its own. */
  trialCurrency: string;
  /** The viewer's zone, which every time is drawn in. */
  zone: string;
  onBack: () => void;
  onDone: () => void;
}

/**
 * Step two of the mentorship dialog: pick the trial's time, add a note, and
 * book it. A free trial is confirmed at once; a paid one holds the time and
 * goes to checkout.
 */
export function MentorshipTrialStep({
  consultantProfileId,
  consultantName,
  subscriptionPlanId,
  planTitle,
  trialDurationMinutes,
  trialPriceInPaise,
  trialCurrency,
  zone,
  onBack,
  onDone,
}: Readonly<MentorshipTrialStepProps>) {
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
  const [notes, setNotes] = useState("");
  const [pick, setPick] = useState<SingleTimeValue | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  // Back on this expert with this plan's trial step open after sign-in.
  const signInHref = useMemo(() => {
    const returnTo = `${pathname}?${new URLSearchParams({ action: "trial", plan: subscriptionPlanId }).toString()}`;
    return `/auth/signin?callbackUrl=${encodeURIComponent(returnTo)}`;
  }, [pathname, subscriptionPlanId]);

  const handleSubmit = async () => {
    if (!session?.user?.id) {
      router.push(signInHref);
      return;
    }
    if (!pick) {
      toast({ title: "Pick a time first", variant: "destructive" });
      return;
    }

    try {
      setIsSubmitting(true);
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

      const eligibility = eligibilityAnswerSchema.parse(
        await requireJsonResponse(
          await fetch(
            `/api/trials/check-eligibility?consulteeProfileId=${consulteeProfileId}&consultantProfileId=${consultantProfileId}&subscriptionPlanId=${subscriptionPlanId}`,
          ),
          "Eligibility check failed",
        ),
      ).data;
      if (!eligibility.isEligible) {
        toast({
          title: "Not eligible",
          description:
            eligibility.reason ||
            "You are not eligible for a trial with this expert",
          variant: "destructive",
        });
        return;
      }

      const response = await fetch("/api/trials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          trialCreateBody({
            consulteeProfileId,
            consultantProfileId,
            subscriptionPlanId,
            notes: notes.trim() || undefined,
            pick,
          }),
        ),
      });
      // A paid trial holds the time while the buyer pays: straight to checkout.
      const createdBody = createdAnswerSchema.safeParse(
        await requireJsonResponse(response, "Trial request failed"),
      );
      const checkoutUrl = createdBody.success
        ? createdBody.data.checkoutUrl
        : null;
      if (checkoutUrl) {
        router.push(checkoutUrl);
        return;
      }

      setIsSuccess(true);
      toast({
        title: "Trial booked",
        description: `Your trial with ${consultantName} is confirmed. It's in your appointments.`,
      });
      void invalidateAvailability(queryClient, consultantProfileId);
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
        setPick(null);
        void invalidateAvailability(queryClient, consultantProfileId);
      }
      if (!expected) {
        Sentry.captureException(
          error instanceof Error ? error : new Error(String(error)),
          { tags: { subsystem: "client", flow: "trial-request" } },
        );
      }
      if (error instanceof ApiResponseError && error.status === 429) {
        const retryAt = retryInstantOf(error);
        toast({
          title: "Too many trial requests",
          description: retryAt
            ? `You can request another trial from ${formatDateTimeLabel(retryAt, { zone })}.`
            : "Please try again later.",
          variant: "destructive",
        });
        return;
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

  if (isSuccess) {
    return (
      <div className="space-y-4 p-6 text-center sm:p-8">
        <CheckCircle
          aria-hidden="true"
          className="mx-auto h-12 w-12 text-emerald-400"
        />
        <h3 className="text-xl font-semibold text-white">Trial booked</h3>
        <p className="text-zinc-400">
          Your trial with {consultantName} is confirmed. Find it in your
          appointments.
        </p>
        <Button
          onClick={onDone}
          className="bg-white font-medium text-zinc-900 hover:bg-zinc-100"
        >
          Done
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-5 p-4 sm:p-6 lg:p-8">
        {/* The price is the first thing shown, so a paid trial never reads as free. */}
        <div className="rounded-xl border border-zinc-700/50 bg-zinc-800/50 p-4">
          <p className="text-sm font-medium text-white">{planTitle}</p>
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm text-zinc-400">
              <Clock aria-hidden="true" className="h-4 w-4" />
              {trialDurationMinutes} minute trial
            </span>
            <span
              className={`text-sm font-semibold ${isPaidTrial ? "text-white" : "text-emerald-400"}`}
            >
              {priceLabel}
            </span>
          </div>
        </div>
        {session?.user?.id ? (
          <>
            <SingleTimePicker
              consultantId={consultantProfileId}
              sessionMinutes={trialDurationMinutes}
              zone={zone}
              theme="dark"
              audience="buyer"
              purpose="request"
              settled={!isPaidTrial}
              consulteeUserId={session.user.id}
              value={pick}
              onChange={setPick}
            />
            <div className="space-y-2">
              <label
                htmlFor="trial-notes"
                className="text-sm font-medium text-zinc-300"
              >
                What would you like to discuss? (Optional)
              </label>
              <Textarea
                id="trial-notes"
                placeholder="Share your goals, questions, or topics you'd like to cover in the trial session..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="min-h-[96px] border-zinc-700 bg-zinc-800/60 text-white placeholder:text-zinc-500"
              />
            </div>
            <p className="rounded-xl border border-zinc-700/50 bg-zinc-800/40 p-4 text-sm text-zinc-400">
              {isPaidTrial
                ? `You pay ${priceLabel} next. The time is held for you while you pay, and confirmed as soon as the payment goes through.`
                : "Your trial is confirmed as soon as you book it."}
            </p>
          </>
        ) : (
          <div className="space-y-4 py-6 text-center">
            <p className="text-zinc-400">
              Sign in to pick a time for a trial with {consultantName}.
            </p>
            <Button
              asChild
              className="bg-white text-zinc-900 hover:bg-zinc-100"
            >
              <Link href={signInHref} prefetch>
                Sign in to continue
              </Link>
            </Button>
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-col-reverse gap-3 rounded-b-2xl border-t border-zinc-800 bg-zinc-800/50 px-4 py-4 sm:flex-row sm:justify-between sm:px-6">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isSubmitting}
          className="border-zinc-700 bg-transparent text-zinc-200 hover:bg-zinc-800 hover:text-white"
        >
          Back
        </Button>
        {session?.user?.id && (
          <Button
            onClick={() => void handleSubmit()}
            disabled={isSubmitting || !pick}
            className="bg-white font-medium text-zinc-900 hover:bg-zinc-100"
          >
            {isSubmitting ? (
              <>
                <Loader2
                  aria-hidden="true"
                  className="mr-2 h-4 w-4 animate-spin"
                />
                Booking...
              </>
            ) : (
              <>
                <Gift aria-hidden="true" className="mr-2 h-4 w-4" />
                {isPaidTrial ? "Continue to payment" : "Book trial"}
              </>
            )}
          </Button>
        )}
      </div>
    </>
  );
}
