"use client";

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
import { ClassPlanProgram } from "@/app/explore/programs/utils";
import {
  isUserEnrolled,
  countUniqueParticipants,
} from "@/lib/payments/utils/participants";
import { useCurrency } from "@/hooks/useCurrency";
import { formatInTimeZone } from "date-fns-tz";
import { JoinWaitlistButton } from "@/components/waitlist/JoinWaitlistButton";
import { WaitlistBadge } from "@/components/waitlist/WaitlistBadge";

type ClientClassRegistrationProps = {
  readonly plan: ClassPlanProgram;
  maxParticipants?: number;
  waitlist?: Array<{ userId: string; position?: number | null }>;
  consultantUserId?: string;
};

export function ClientClassRegistration({
  plan,
  maxParticipants,
  waitlist = [],
  consultantUserId,
}: ClientClassRegistrationProps) {
  const { id: classId, price, classes } = plan;
  const startDate = classes?.[0]?.schedulingPeriodStartsAt;
  const { data: session } = useSession();
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

  // Check if user is already enrolled in this class
  const appointments = classes?.flatMap((c) => c.appointments ?? []) ?? [];
  const isAlreadyEnrolled = userId
    ? isUserEnrolled(appointments, userId)
    : false;

  // Calculate capacity - use plan's maxParticipants or prop override
  const effectiveMaxParticipants =
    maxParticipants ?? plan.maxParticipants ?? 100;
  const currentParticipants = countUniqueParticipants(
    appointments,
    consultantUserId ? [consultantUserId] : [],
  );
  const isFull = currentParticipants >= effectiveMaxParticipants;

  // Check if user is on the waitlist
  const userWaitlistEntry = userId
    ? waitlist.find((w) => w.userId === userId)
    : null;
  const isOnWaitlist = !!userWaitlistEntry;

  const handleRegistration = () => {
    const checkoutUrl = `/checkout/plans/class/${classId}`;
    if (!isLoggedIn) {
      // Preserve the checkout destination as a RELATIVE callbackUrl (the sign-in
      // page drops absolute URLs) so a first-timer lands on checkout after auth +
      // onboarding.
      window.location.href = `/auth/signin?callbackUrl=${encodeURIComponent(checkoutUrl)}`;
      return;
    }
    window.location.href = checkoutUrl;
  };

  if (!isLoggedIn) {
    // Determine button state for non-logged in users
    const signInButtonText = isFull ? "Class is Full" : "Sign in to Register";
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
              Class is full ({currentParticipants}/{effectiveMaxParticipants}{" "}
              spots)
            </Badge>
          )}
          {!isFull && (
            <p className="text-muted-foreground mb-4">
              Please sign in to register for this class.
            </p>
          )}
          <Button
            onClick={handleRegistration}
            className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
            disabled={signInButtonDisabled}
          >
            {signInButtonText}
          </Button>
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

  // Show waitlist UI when class is full
  if (isFull && isLoggedIn && !isAlreadyEnrolled) {
    // Get the first class instance ID for waitlist operations
    const classInstanceId = classes?.[0]?.id;

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
            Class is full ({currentParticipants}/{effectiveMaxParticipants}{" "}
            spots)
          </Badge>
        </CardContent>
        <CardFooter>
          {isOnWaitlist ? (
            <div className="w-full text-center">
              <WaitlistBadge
                position={userWaitlistEntry?.position ?? null}
                variant="extended"
              />
              <p className="text-xs text-muted-foreground mt-2">
                We'll notify you when a spot opens up
              </p>
            </div>
          ) : classInstanceId ? (
            <JoinWaitlistButton
              eventType="class"
              eventId={classInstanceId}
              className="w-full"
            />
          ) : (
            <p className="text-sm text-muted-foreground text-center">
              No class instance available for waitlist
            </p>
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
            ? `Class starts on ${formatInTimeZone(new Date(startDate), userTimeZone, "MMMM d, yyyy 'at' h:mm a zzz")}`
            : "Start date to be announced"}
        </p>
      </CardContent>
      <CardFooter>
        <Button
          onClick={handleRegistration}
          className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
        >
          Pay {formatPrice(price)} & Register Now
        </Button>
      </CardFooter>
    </Card>
  );
}
