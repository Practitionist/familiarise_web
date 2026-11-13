"use client";

import { HELD_BY_SOMEONE_ELSE } from "@/components/booking/NotifyWhenFreeButton";
import {
  SingleTimePicker,
  type SingleTimeValue,
} from "@/components/scheduling/SingleTimePicker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import * as Sentry from "@sentry/nextjs";
import { motion } from "framer-motion";
import { CheckCircle2 } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { requestForApprovalBody } from "@/lib/booking/picked-time";
import { ApiResponseError, requireJsonResponse } from "@/lib/fetch-helpers";
import {
  isExpectedRefusal,
  userMessageFrom,
} from "@/lib/errors/client-refusal";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { PricingOption } from "../defaults";
import { ZoneSwitch } from "@/components/scheduling/ZoneSwitch";
import type { DisplayZone } from "@/lib/time/use-display-zone";
import {
  consumePurchaseIntent,
  stashPurchaseIntent,
} from "@/utils/purchase-intent";
import { useToast } from "@/hooks/use-toast";
import { useBuyerPrice } from "@/components/pricing/BuyerPriceProvider";
import { buyerDisplayPricePaise } from "@/lib/payments/pricing/display-price";
import { formatCurrencyAmount } from "@/utils/formatting";
import type { BookingMode } from "@prisma/client";
import {
  CONSULTANT_PAUSED_HINT,
  consultationCtaFor,
} from "@/lib/booking/booking-mode";

interface ConsultantDetailsForBooking {
  id: string;
  /** Absent on older payloads; INSTANT then. */
  bookingMode?: BookingMode;
  /** False while the expert has paused new bookings of every kind. */
  acceptingRequests?: boolean;
  consultationPlans: Array<{
    id: string;
    durationInHours: number;
  }>;
}

interface ConsultationPricingToggleProps {
  consultationOptions: PricingOption[];
  consultantDetails: ConsultantDetailsForBooking;
  handleConsultationBooking: (
    consultationPlanId: string,
    pick: SingleTimeValue,
  ) => void;
  /** The zone every time in the dialog is drawn in, with its device-zone switch. */
  displayZone: DisplayZone;
  /** The signed-in buyer, so their own busy times read taken. */
  consulteeUserId?: string;
  /** Set when the page is entered after a taken-time refusal; the next read skips the cache. */
  bypassRef?: MutableRefObject<boolean>;
  onRefreshSlots?: () => void;
  onDurationChange?: (durationInHours: number) => void;
}

export default function ConsultationPricingToggle({
  consultationOptions,
  handleConsultationBooking,
  displayZone,
  consultantDetails,
  consulteeUserId,
  bypassRef,
  onRefreshSlots,
  onDurationChange,
}: Readonly<ConsultationPricingToggleProps>) {
  const { data: session } = useSession();
  const router = useRouter();
  const { toast } = useToast();
  const { gstRegistered, formatBuyerPrice, noteFor } = useBuyerPrice();
  // Track the active plan by id so plans that share a duration (e.g. two
  // 1-hour consultations) remain independently selectable and bookable.
  const [activeConsultationOption, setActiveConsultationOption] =
    useState<string>(consultationOptions[0]?.id ?? "");
  const [dialogPlanId, setDialogPlanId] = useState<string | null>(null);
  const [pick, setPick] = useState<SingleTimeValue | null>(null);
  // Times the request door said someone else holds: shown taken with "Notify me".
  const [heldStarts, setHeldStarts] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [isRequestingApproval, setIsRequestingApproval] = useState(false);
  // A taken time the visitor asked to wait on before signing in.
  const [revealTakenAt, setRevealTakenAt] = useState<string | null>(null);

  const activePlanOption = useMemo(
    () =>
      consultationOptions.find((opt) => opt.id === activeConsultationOption),
    [activeConsultationOption, consultationOptions],
  );

  const selectedDuration = activePlanOption?.durationInHours ?? 1;
  const mode = consultantDetails.bookingMode ?? "INSTANT";
  const requestMode = mode === "REQUEST";

  useEffect(() => {
    onDurationChange?.(selectedDuration);
  }, [selectedDuration, onDurationChange]);

  const paused = consultantDetails.acceptingRequests === false;
  const cta = consultationCtaFor(mode);

  const choosePlan = (planId: string) => {
    setActiveConsultationOption(planId);
    // A pick belongs to one session length; another plan has other windows.
    setPick(null);
    setHeldStarts(new Set());
  };

  // A pick stashed before the sign-in bounce comes back once per mount; the
  // picker clears it if the time has gone since.
  const purchaseIntentConsumedRef = useRef(false);
  // One Idempotency-Key per (plan, time) attempt; a retry of the same attempt resends it.
  const requestAttemptRef = useRef<{ selection: string; key: string } | null>(
    null,
  );
  const userId = session?.user?.id;
  useEffect(() => {
    if (purchaseIntentConsumedRef.current || !userId) return;
    purchaseIntentConsumedRef.current = true;
    const intent = consumePurchaseIntent(consultantDetails.id);
    if (!intent) return;
    const intentPlan = consultationOptions.find(
      (opt) => opt.id === intent.consultationPlanId,
    );
    if (!intentPlan) return;
    setActiveConsultationOption(intentPlan.id);
    setDialogPlanId(intentPlan.id);
    if (intent.waitOn) {
      setRevealTakenAt(intent.slot.startsAt);
      toast({
        title: "Welcome back",
        description: "Press Notify me on the time you wanted.",
      });
      return;
    }
    const { startsAt, endsAt, type, availabilityWindowId } = intent.slot;
    setPick({
      startsAt,
      endsAt,
      ...(type && availabilityWindowId
        ? { window: { id: availabilityWindowId, type } }
        : {}),
    });
    toast({
      title: "Welcome back",
      description: "The time you picked before signing in is selected.",
    });
  }, [userId, consultantDetails.id, consultationOptions, toast]);

  const sendToSignIn = () => {
    const callbackUrl = `${window.location.pathname}${window.location.search}`;
    router.push(`/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  };

  // A signed-out "Notify me" signs in first and comes back to this dialog.
  const notifyAfterSignIn = (planId: string) =>
    session?.user?.id
      ? undefined
      : (taken: SingleTimeValue) => {
          stashPurchaseIntent({
            consultantId: consultantDetails.id,
            consultationPlanId: planId,
            slot: { startsAt: taken.startsAt, endsAt: taken.endsAt },
            waitOn: true,
          });
          sendToSignIn();
        };

  const handleRequestForApproval = async (planId: string) => {
    if (!pick) {
      toast({ title: "Pick a time first", variant: "destructive" });
      return;
    }

    if (!session?.user?.id) {
      // Guests sign in first; the pick rides through the bounce in session
      // storage and is restored above.
      stashPurchaseIntent({
        consultantId: consultantDetails.id,
        consultationPlanId: planId,
        slot: {
          startsAt: pick.startsAt,
          endsAt: pick.endsAt,
          type: pick.window?.type,
          availabilityWindowId: pick.window?.id,
        },
      });
      sendToSignIn();
      return;
    }

    const activePlan = consultantDetails.consultationPlans.find(
      (plan) => plan.id === planId,
    );
    if (!activePlan) {
      toast({
        title: "This consultation isn't available right now",
        variant: "destructive",
      });
      return;
    }

    setIsRequestingApproval(true);
    try {
      const selection = `${activePlan.id}|${pick.startsAt}|${pick.endsAt}`;
      if (requestAttemptRef.current?.selection !== selection) {
        requestAttemptRef.current = {
          selection,
          key: `rq_${globalThis.crypto.randomUUID().replace(/-/g, "")}`,
        };
      }

      const response = await fetch("/api/scheduling/request-for-approval", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": requestAttemptRef.current.key,
        },
        body: JSON.stringify(
          requestForApprovalBody({
            consultantProfileId: consultantDetails.id,
            consultationPlanId: activePlan.id,
            pick,
          }),
        ),
      });

      // Never bare response.json(): an edge 504/HTML page would throw a
      // SyntaxError into the toast instead of the server's reason.
      await requireJsonResponse(
        response,
        "Failed to submit request for approval",
      );
      requestAttemptRef.current = null;

      toast({
        title: "Request sent",
        description:
          "The expert will confirm or decline soon. You pay only once they confirm.",
        variant: "default",
      });
      setPick(null);
    } catch (error) {
      console.warn("Request for approval failed", error);
      if (
        error instanceof ApiResponseError &&
        error.code &&
        HELD_BY_SOMEONE_ELSE.has(error.code)
      ) {
        const heldAt = Date.parse(pick.startsAt);
        // The picker says so inline and opens its taken times.
        setHeldStarts((held) => new Set([...held, heldAt]));
        setPick(null);
        onRefreshSlots?.();
        return;
      }
      // A modelled refusal carries a sentence written for the buyer; anything
      // else (a crash, an edge page, no network) gets fixed copy and Sentry.
      const refused =
        isExpectedRefusal(error) &&
        error instanceof ApiResponseError &&
        error.code !== undefined;
      if (!isExpectedRefusal(error)) {
        Sentry.captureException(error, {
          tags: { subsystem: "client", flow: "request-for-approval" },
        });
      }
      toast({
        title: "Couldn't send your request",
        description: refused
          ? userMessageFrom(error)
          : "Please try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setIsRequestingApproval(false);
    }
  };

  const handleBookNowClick = (planId: string) => {
    if (planId !== activeConsultationOption) choosePlan(planId);
    setDialogPlanId(planId);
  };

  if (consultationOptions.length === 0) {
    return (
      <div className="w-full p-8 text-center text-zinc-400">
        <p>No consultation plans available at the moment.</p>
      </div>
    );
  }

  if (
    session?.user?.role &&
    ["consultant", "staff"].includes(session.user.role.toLowerCase())
  ) {
    return (
      <div className="w-full p-8 text-center space-y-3">
        <h3 className="text-2xl font-medium tracking-tight text-zinc-300">
          Consultee Access Required
        </h3>
        <p className="text-zinc-500">
          To book consultations, please sign in with a consultee account.
        </p>
      </div>
    );
  }

  return (
    <Tabs
      value={activeConsultationOption}
      onValueChange={choosePlan}
      className="w-full space-y-5"
    >
      {/* Segmented pill duration toggle */}
      <TabsList className="relative flex p-1 bg-white/[0.06] rounded-2xl border border-white/[0.08] backdrop-blur-sm h-auto">
        {consultationOptions.map((option) => {
          const isActive = activeConsultationOption === option.id;
          return (
            <TabsTrigger
              key={option.id}
              value={option.id}
              className="relative flex-1 py-2.5 text-xs sm:text-sm font-medium rounded-xl data-[state=active]:text-zinc-900 data-[state=active]:bg-transparent data-[state=active]:shadow-none text-zinc-400 transition-colors duration-300 z-10 h-auto whitespace-nowrap"
            >
              {isActive && (
                <motion.div
                  layoutId="consultation-duration-pill"
                  className="absolute inset-0 bg-white rounded-xl shadow-sm"
                  transition={{ type: "spring", bounce: 0.15, duration: 0.35 }}
                />
              )}
              <span className="relative z-10">{option.title}</span>
            </TabsTrigger>
          );
        })}
      </TabsList>

      <div className="grid grid-cols-1 gap-4">
        {consultationOptions.map((option) => {
          const isActive = activeConsultationOption === option.id;
          return (
            <motion.div
              key={option.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{
                opacity: isActive ? 1 : 0,
                y: 0,
              }}
              transition={{ duration: 0.2 }}
              className={isActive ? "block" : "hidden"}
            >
              {/* Pricing content — no nested dark card, lives directly in glass parent */}
              <div className="space-y-1">
                <h3 className="text-lg font-bold text-white">{option.title}</h3>
                <p className="text-xs text-zinc-500">{option.description}</p>
              </div>

              <div className="flex items-end gap-2 my-5">
                <span className="text-5xl font-bold tracking-tight text-white">
                  {option.priceCurrency &&
                  option.priceCurrency.toUpperCase() !== "INR"
                    ? formatCurrencyAmount(
                        buyerDisplayPricePaise(option.price, gstRegistered),
                        option.priceCurrency,
                      )
                    : formatBuyerPrice(option.price)}
                </span>
                <span className="text-zinc-500 text-sm mb-1.5">
                  / session
                  {noteFor(option.price) ? ` · ${noteFor(option.price)}` : ""}
                </span>
              </div>

              {option.features && option.features.length > 0 && (
                <>
                  <div className="border-t border-white/[0.06] mb-4" />
                  <div className="space-y-2 mb-5">
                    <p className="text-xs text-zinc-500 font-medium uppercase tracking-wider">
                      Includes
                    </p>
                    <ul className="space-y-2">
                      {option.features.map((feature, index) => (
                        <li
                          key={`feature-${index}`}
                          className="text-zinc-200 flex items-center text-sm"
                        >
                          <CheckCircle2 className="w-4 h-4 mr-2.5 text-emerald-400 flex-shrink-0" />
                          {feature}
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}

              {/* Two CTAs: read first, or book now. The toggle stays a chooser
                and hands detail off to the plan page. */}
              <Button
                asChild
                variant="outline"
                className="w-full mb-3 bg-white/[0.05] border border-white/[0.12] text-zinc-200 hover:bg-white/[0.10] hover:text-white font-medium rounded-xl h-11 text-sm transition-all duration-200"
              >
                <Link
                  href={`/explore/programs/plans/consultations/${option.id}`}
                >
                  Open details
                </Link>
              </Button>

              <Button
                className="w-full bg-white text-zinc-900 hover:bg-zinc-100 font-semibold rounded-xl h-12 text-sm tracking-wide transition-all duration-200 hover:shadow-[0_0_20px_rgba(255,255,255,0.15)]"
                onClick={() => handleBookNowClick(option.id)}
              >
                Book Now
              </Button>
              <Dialog
                open={dialogPlanId === option.id}
                onOpenChange={(open) =>
                  setDialogPlanId(open ? option.id : null)
                }
              >
                {/* Centred, with a gutter on every side and never taller than the
                    screen: the header and the checkout button stay put and only
                    the middle scrolls. Width steps up with the screen. */}
                <DialogContent className="flex max-h-[min(calc(100dvh-1.5rem),52rem)] w-[calc(100vw-1.5rem)] flex-col gap-0 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 p-0 text-white shadow-2xl sm:max-w-[640px] sm:rounded-2xl md:max-w-[880px] lg:max-w-[960px] xl:max-w-[1050px]">
                  <DialogHeader className="shrink-0 border-b border-zinc-800 p-4 pr-12 sm:p-6 sm:pr-14 lg:p-8 lg:pr-14">
                    <DialogTitle className="text-lg sm:text-xl lg:text-2xl font-semibold">
                      Book {option.title} Consultation
                    </DialogTitle>
                    <DialogDescription className="text-zinc-400 text-base">
                      Select a date and time for your {option.duration}{" "}
                      consultation
                    </DialogDescription>
                    <ZoneSwitch
                      zone={displayZone.zone}
                      usingDeviceZone={displayZone.usingDeviceZone}
                      canSwitch={displayZone.canSwitch}
                      onToggle={displayZone.toggle}
                      className="pt-1 text-zinc-400 [&_button]:text-zinc-100"
                    />
                  </DialogHeader>
                  <DialogBody>
                    <div className="p-4 sm:p-6 lg:p-8">
                      <SingleTimePicker
                        consultantId={consultantDetails.id}
                        sessionMinutes={Math.round(
                          (option.durationInHours ?? 1) * 60,
                        )}
                        zone={displayZone.zone}
                        theme="dark"
                        audience="buyer"
                        purpose={requestMode ? "request" : "book"}
                        settled={Number(option.price ?? 0) <= 0}
                        consulteeUserId={consulteeUserId}
                        heldStarts={heldStarts}
                        notifyPlan={{
                          planKind: "CONSULTATION",
                          planId: option.id,
                          onSignIn: notifyAfterSignIn(option.id),
                        }}
                        revealTakenAt={revealTakenAt}
                        bypassRef={bypassRef}
                        value={pick}
                        onChange={setPick}
                      />
                    </div>
                  </DialogBody>
                  <div className="shrink-0 bg-zinc-800/50 px-4 sm:px-6 lg:px-8 py-4 sm:py-5 flex flex-col items-stretch sm:items-end gap-2 rounded-b-2xl border-t border-zinc-800">
                    {(paused || cta.hint) && (
                      <p className="text-xs text-zinc-400 text-right">
                        {paused ? CONSULTANT_PAUSED_HINT : cta.hint}
                      </p>
                    )}
                    <Button
                      className="bg-white text-zinc-900 hover:bg-zinc-100 font-medium px-8 h-12 text-base w-full sm:w-auto"
                      onClick={() => {
                        if (cta.action === "request") {
                          void handleRequestForApproval(option.id);
                        } else if (pick) {
                          handleConsultationBooking(option.id, pick);
                        }
                      }}
                      disabled={!pick || paused || isRequestingApproval}
                    >
                      {isRequestingApproval ? "Submitting..." : cta.label}
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </motion.div>
          );
        })}
      </div>
    </Tabs>
  );
}
