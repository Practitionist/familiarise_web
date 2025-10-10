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
  webinarPlanId: string; // Renamed from webinarId
  price: number;
  currency?: string | null; // Added
  nextSessionDate?: Date; // Renamed from nextSession
  sessionStatus: SessionStatus; // Added
};

export function ClientWebinarRegistration({
  webinarPlanId,
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
    // Ensure we only redirect to checkout if the session is upcoming
    if (sessionStatus === "Upcoming") {
      window.location.href = `/checkout/events/webinar/${webinarPlanId}`;
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
  }
  // Note: If sessionStatus is "To be announced" and there's no nextSessionDate,
  // the button will still say "Pay & Register Now" and be enabled by default.
  // Additional logic could be added here if registration should be disabled for "To be announced" status.

  if (!isLoggedIn) {
    // For non-logged in users, the button primarily serves to redirect to sign-in.
    // We can still reflect the session status in the button text and disable it if not upcoming.
    let signInButtonText = "Sign in to Register";
    if (sessionStatus === "Completed") {
      signInButtonText = "Session Ended";
    } else if (sessionStatus === "Happening Now") {
      signInButtonText = "Session in Progress";
    }

    return (
      <Card className="bg-gradient-to-br from-gray-900/90 to-gray-800/80 border-gray-700/50">
        <CardHeader>
          <CardTitle className="text-white">Register for Webinar</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-gray-300 mb-4">
            {sessionInfoText} {/* Show current session status info */}
          </p>
          <p className="text-gray-300 mb-4">
            Please sign in to register for this webinar.
          </p>
          <Button
            onClick={handleRegistration} // This redirects to sign-in
            className="w-full bg-black hover:bg-gray-800"
            disabled={
              sessionStatus === "Completed" || sessionStatus === "Happening Now"
            } // Disable if not upcoming
          >
            {signInButtonText}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-gradient-to-br from-gray-900/90 to-gray-800/80 border-gray-700/50">
      <CardHeader>
        <CardTitle className="text-white">Join Webinar</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-gray-300 mb-4">{sessionInfoText}</p>
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
