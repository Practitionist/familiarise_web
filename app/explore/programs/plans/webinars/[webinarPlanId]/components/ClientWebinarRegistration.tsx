"use client";

import { useSession } from "next-auth/react";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// Redefine SessionStatus (or import if moved to a shared file)
type SessionStatus =
  | "Upcoming"
  | "Happening Now"
  | "Completed"
  | "To be announced";

type ClientWebinarRegistrationProps = {
  webinarPlanId: string; // The WebinarPlan ID (for URL path)
  webinarId?: string; // The actual Webinar instance ID (for eventId query param)
  price: number;
  currency?: string | null;
  nextSessionDate?: Date;
  sessionStatus: SessionStatus;
};

export function ClientWebinarRegistration({
  webinarPlanId,
  webinarId,
  price,
  currency,
  nextSessionDate,
  sessionStatus,
}: ClientWebinarRegistrationProps) {
  const { data: session } = useSession();
  const isLoggedIn = !!session?.user;

  const handleRegistration = () => {
    if (!isLoggedIn) {
      window.location.href = `/auth/signin?callbackUrl=${encodeURIComponent(window.location.href)}`;
      return;
    }
    // Ensure we only redirect to checkout if the session is upcoming AND we have a webinar instance ID
    if (sessionStatus === "Upcoming" && webinarId) {
      window.location.href = `/checkout/plans/webinar/${webinarPlanId}?eventId=${webinarId}`;
    }
  };

  let sessionInfoText: string;
  if (nextSessionDate) {
    const formattedDate = new Date(nextSessionDate).toLocaleString(undefined, {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    if (sessionStatus === "Completed") {
      sessionInfoText = `Session ended: ${formattedDate}`;
    } else if (sessionStatus === "Happening Now") {
      sessionInfoText = `Session started: ${formattedDate}`;
    } else if (sessionStatus === "Upcoming") {
      sessionInfoText = `Next session: ${formattedDate}`;
    } else {
      // "To be announced" but has a nextSessionDate (edge case) or other unhandled status
      sessionInfoText = `Scheduled: ${formattedDate}`;
    }
  } else if (sessionStatus === "Completed") {
    sessionInfoText = "This webinar has ended.";
  } else if (sessionStatus === "Happening Now") {
    sessionInfoText = "This webinar is currently in progress.";
  } else {
    // Fallback for !nextSessionDate and status is "Upcoming" or "To be announced"
    sessionInfoText = "Session time to be announced.";
  }

  // Logic for buttonText and buttonDisabled
  let buttonText = `Pay $${price} ${currency ?? "USD"} & Register Now`;
  let buttonDisabled = false;

  if (sessionStatus === "Completed") {
    buttonText = "Session Ended";
    buttonDisabled = true;
  } else if (sessionStatus === "Happening Now") {
    buttonText = "Session in Progress";
    buttonDisabled = true;
  } else if (sessionStatus === "To be announced" || !webinarId) {
    // Disable registration when no session is scheduled or no webinar instance exists
    buttonText = "Registration Opening Soon";
    buttonDisabled = true;
  }

  if (!isLoggedIn) {
    // For non-logged in users, the button primarily serves to redirect to sign-in.
    // We can still reflect the session status in the button text and disable it if not upcoming.
    let signInButtonText = "Sign in to Register";
    let signInButtonDisabled = false;

    if (sessionStatus === "Completed") {
      signInButtonText = "Session Ended";
      signInButtonDisabled = true;
    } else if (sessionStatus === "Happening Now") {
      signInButtonText = "Session in Progress";
      signInButtonDisabled = true;
    } else if (sessionStatus === "To be announced" || !webinarId) {
      signInButtonText = "Registration Opening Soon";
      signInButtonDisabled = true;
    }

    return (
      <Card>
        <CardHeader>
          <CardTitle>Register for Webinar</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-gray-600 mb-4">
            {sessionInfoText} {/* Show current session status info */}
          </p>
          {!signInButtonDisabled && (
            <p className="text-gray-600 mb-4">
              Please sign in to register for this webinar.
            </p>
          )}
          <Button
            onClick={handleRegistration} // This redirects to sign-in
            className="w-full bg-black hover:bg-gray-800"
            disabled={signInButtonDisabled}
          >
            {signInButtonText}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Join Webinar</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-gray-600 mb-4">{sessionInfoText}</p>
      </CardContent>
      <CardFooter>
        <Button
          onClick={handleRegistration}
          className="w-full bg-black hover:bg-gray-800"
          disabled={buttonDisabled}
        >
          {buttonText}
        </Button>
      </CardFooter>
    </Card>
  );
}
