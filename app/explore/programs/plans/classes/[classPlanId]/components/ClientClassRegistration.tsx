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
import { isUserEnrolled } from "@/lib/payments/utils/participants";
import { useCurrency } from "@/hooks/useCurrency";
import { formatInTimeZone } from "date-fns-tz";
import { getClassCapacity } from "@/lib/events/capacity";
import { FreeCancellationLine } from "@/components/events/FreeCancellationLine";

type ClientClassRegistrationProps = {
  readonly plan: ClassPlanProgram;
  maxParticipants?: number;
  consultantUserId?: string;
};

export function ClientClassRegistration({
  plan,
  maxParticipants,
  consultantUserId,
}: ClientClassRegistrationProps) {
  const { id: classId, price, classes } = plan;
  const startDate = classes?.[0]?.schedulingPeriodStartsAt;
  const { data: session } = useSession();
  const router = useRouter();
  const { formatPrice } = useCurrency();

  // Defer auth + timezone until after hydration to avoid mismatch
  const [hasMounted, setHasMounted] = useState(false);
  const [userTimeZone, setUserTimeZone] = useState("UTC");
  useEffect(() => {
    setHasMounted(true);
    setUserTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  const isLoggedIn = hasMounted && !!session?.user;
  const userId = session?.user?.id;

  // Check if user is already enrolled in this class (#1554: one wrapper)
  const appointment = classes?.[0]?.appointment ?? null;
  const isAlreadyEnrolled = userId
    ? isUserEnrolled(appointment, userId)
    : false;

  // Capacity comes from the class instance when it sets one, else the plan.
  const capacity = getClassCapacity({
    classInstance: {
      maxParticipants: classes?.[0]?.maxParticipants ?? null,
      appointment,
    },
    plan: { maxParticipants: maxParticipants ?? plan.maxParticipants ?? 100 },
    excludeUserIds: consultantUserId ? [consultantUserId] : [],
  });
  const isFull = capacity.isFull;

  const checkoutUrl = `/checkout/plans/class/${classId}`;
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
              ? `Class starts on ${formatInTimeZone(new Date(startDate), userTimeZone, "MMMM d, yyyy 'at' h:mm a zzz")}`
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
          {signInButtonDisabled ? (
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
          )}
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
              ? `Class starts on ${formatInTimeZone(new Date(startDate), userTimeZone, "MMMM d, yyyy 'at' h:mm a zzz")}`
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
              ? `Class starts on ${formatInTimeZone(new Date(startDate), userTimeZone, "MMMM d, yyyy 'at' h:mm a zzz")}`
              : "Start date to be announced"}
          </p>
          <Badge
            variant="secondary"
            className="mb-4 bg-amber-100 text-amber-800"
          >
            Sold out — all {capacity.max} seats taken
          </Badge>
          <p className="text-sm text-muted-foreground">
            Enrollment for this class is closed. Check back in case the
            instructor opens more seats.
          </p>
        </CardContent>
        <CardFooter>
          <Button className="w-full" disabled>
            Sold out
          </Button>
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
            ? `Class starts on ${formatInTimeZone(new Date(startDate), userTimeZone, "MMMM d, yyyy 'at' h:mm a zzz")}`
            : "Start date to be announced"}
        </p>
        <FreeCancellationLine
          startsAt={startDate}
          windowHours={plan.refundWindowHours}
        />
      </CardContent>
      <CardFooter>
        <Button
          asChild
          className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
        >
          <Link href={checkoutUrl} prefetch>
            Pay {formatPrice(price)} & Register Now
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}
