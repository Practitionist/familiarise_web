"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { useSession } from "@/lib/auth-client";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle } from "lucide-react";
import { ClassPlanProgram } from "@/lib/explore/programs";
import { useBuyerPrice } from "@/components/pricing/BuyerPriceProvider";
import { formatInViewerZone } from "@/lib/time/viewer-zone";
import { eventCapacityFromCount } from "@/lib/events/capacity";
import { FreeCancellationLine } from "@/components/events/FreeCancellationLine";
import type { BatchCard } from "@/lib/booking/batch-cards";
import { GroupSessionDisclosure } from "@/components/booking/GroupSessionDisclosure";
import { NotifyMeButton } from "@/components/booking/NotifyMeButton";
import { useRefreshOnViewerChange } from "@/hooks/useRefreshOnViewerChange";

type ClientClassRegistrationProps = {
  readonly plan: ClassPlanProgram;
  maxParticipants?: number;
  /** Batches' appointments the signed-in viewer holds a seat on; read by the server. */
  enrolledAppointmentIds: readonly string[];
  /** Batches' appointments the viewer is on the notify-me list of; read by the server. */
  waitingAppointmentIds: readonly string[];
  /** Who the server rendered for. */
  viewerUserId: string | null;
  /** The host takes a notify-me list when a batch sells out. */
  waitlistEnabled: boolean;
  /** #1819 — the batch this card sells: the first joinable one, else the first. */
  batch?: BatchCard;
};

export function ClientClassRegistration({
  plan,
  maxParticipants,
  enrolledAppointmentIds,
  waitingAppointmentIds,
  viewerUserId,
  waitlistEnabled,
  batch,
}: ClientClassRegistrationProps) {
  const { id: classId, price, classes } = plan;
  const batchClass =
    classes?.find((c) => c.id === batch?.classId) ?? classes?.[0];
  const startDate = batch?.startsAt ?? batchClass?.schedulingPeriodStartsAt;
  const { data: session } = useSession();
  const router = useRouter();
  const { formatBuyerPriceLabel } = useBuyerPrice();
  useRefreshOnViewerChange(viewerUserId);

  // Defer auth + timezone until after hydration to avoid mismatch
  const [hasMounted, setHasMounted] = useState(false);
  const [userTimeZone, setUserTimeZone] = useState("UTC");
  useEffect(() => {
    setHasMounted(true);
    setUserTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  const isLoggedIn = hasMounted && !!session?.user;

  // Enrolled in any batch of this listing (one wrapper per batch).
  const isAlreadyEnrolled =
    isLoggedIn &&
    (classes ?? []).some(
      (c) =>
        !!c.appointment && enrolledAppointmentIds.includes(c.appointment.id),
    );

  // Capacity comes from the class instance when it sets one, else the plan.
  const capacity = eventCapacityFromCount({
    instance: { maxParticipants: batchClass?.maxParticipants ?? null },
    plan: { maxParticipants: maxParticipants ?? plan.maxParticipants ?? 100 },
    taken: batchClass?.appointment?._count?.participants ?? 0,
  });
  const isFull = capacity.isFull;
  const batchAppointmentId = batchClass?.appointment?.id;
  const isWaiting =
    !!batchAppointmentId && waitingAppointmentIds.includes(batchAppointmentId);
  // A waiter keeps a way to leave after a seat opens and the card stops reading full.
  const canJoin =
    isFull &&
    waitlistEnabled &&
    batch?.enrolment.state === "open" &&
    batch.phase !== "completed";
  const notifyMe =
    batchClass && batchAppointmentId && (canJoin || isWaiting) ? (
      <NotifyMeButton
        kind="CLASS"
        eventId={batchClass.id}
        waiting={isWaiting}
        signedIn={isLoggedIn}
      />
    ) : null;
  // #1819 — a batch past its host's cutoff, or finished, is not for sale.
  const isClosed = !!batch && !batch.canEnrol && !isFull;
  const payPaise =
    batch?.enrolment.state === "open" ? batch.enrolment.basePaise : price;

  const checkoutUrl = batch
    ? `/checkout/plans/class/${classId}?eventId=${batch.classId}`
    : `/checkout/plans/class/${classId}`;
  // Preserve the checkout destination as a RELATIVE callbackUrl (the sign-in
  // page drops absolute URLs) so a first-timer lands on checkout after auth +
  // onboarding.
  const signInHref = `/auth/signin?callbackUrl=${encodeURIComponent(checkoutUrl)}`;

  const handleRegistration = () => {
    if (!isLoggedIn) {
      router.push(signInHref);
      return;
    }
    router.push(checkoutUrl);
  };

  if (isClosed && !isAlreadyEnrolled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Class Registration</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No batch of this class is open for enrolment right now. Check back
            when the instructor opens seats or schedules the next batch.
          </p>
        </CardContent>
        {isWaiting && notifyMe && <CardFooter>{notifyMe}</CardFooter>}
      </Card>
    );
  }

  if (!isLoggedIn) {
    // Determine button state for non-logged in users
    const signInButtonText = isFull ? "Sold out" : "Sign in to Register";
    const signInButtonDisabled = isFull;

    return (
      <Card>
        <CardHeader>
          <CardTitle>Class Registration</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground mb-4">
            {startDate
              ? `Class starts on ${formatInViewerZone(new Date(startDate), userTimeZone, "MMMM d, yyyy 'at' h:mm a zzz")}`
              : "Start date to be announced"}
          </p>
          {isFull && (
            <Badge
              variant="secondary"
              className="mb-4 bg-amber-100 text-amber-800"
            >
              Sold out — all {capacity.max} seats taken
            </Badge>
          )}
          {!isFull && (
            <p className="text-muted-foreground mb-4">
              Please sign in to register for this class.
            </p>
          )}
          {notifyMe ??
            (signInButtonDisabled ? (
              <Button
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
                disabled
              >
                {signInButtonText}
              </Button>
            ) : (
              <Button
                onClick={handleRegistration}
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {signInButtonText}
              </Button>
            ))}
        </CardContent>
      </Card>
    );
  }

  // Show "Already Enrolled" state for logged-in users who are already enrolled
  if (isAlreadyEnrolled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Class Registration</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 mb-4">
            <CheckCircle className="h-5 w-5 text-green-600" />
            <Badge className="bg-green-100 text-green-800 border-green-300">
              Already Enrolled
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            {startDate
              ? `Class starts on ${formatInViewerZone(new Date(startDate), userTimeZone, "MMMM d, yyyy 'at' h:mm a zzz")}`
              : "Start date to be announced"}
          </p>
          <p className="text-sm text-muted-foreground">
            You are enrolled in this class. Check your dashboard for session
            details.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Sold out — enrollment is closed until the host opens more seats.
  if (isFull && isLoggedIn && !isAlreadyEnrolled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Class Registration</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            {startDate
              ? `Class starts on ${formatInViewerZone(new Date(startDate), userTimeZone, "MMMM d, yyyy 'at' h:mm a zzz")}`
              : "Start date to be announced"}
          </p>
          <Badge
            variant="secondary"
            className="mb-4 bg-amber-100 text-amber-800"
          >
            Sold out — all {capacity.max} seats taken
          </Badge>
          <p className="text-sm text-muted-foreground">
            {notifyMe
              ? "Enrollment for this batch is closed. Ask to be notified and we will tell you the moment a seat opens; the first to pay gets it."
              : "Enrollment for this class is closed. Check back in case the instructor opens more seats."}
          </p>
        </CardContent>
        <CardFooter>
          {notifyMe ?? (
            <Button className="w-full" disabled>
              Sold out
            </Button>
          )}
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Class Registration</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground mb-4">
          {startDate
            ? `Class starts on ${formatInViewerZone(new Date(startDate), userTimeZone, "MMMM d, yyyy 'at' h:mm a zzz")}`
            : "Start date to be announced"}
        </p>
        <FreeCancellationLine
          startsAt={startDate}
          windowHours={plan.refundWindowHours}
          kind="class"
        />
        <GroupSessionDisclosure className="mt-2" />
      </CardContent>
      <CardFooter className="flex flex-col gap-2">
        <Button
          asChild
          className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
        >
          <Link href={checkoutUrl} prefetch>
            Pay {formatBuyerPriceLabel(payPaise)} & Register Now
          </Link>
        </Button>
        {isWaiting && notifyMe}
      </CardFooter>
    </Card>
  );
}
