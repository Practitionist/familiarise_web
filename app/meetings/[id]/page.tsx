"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { StreamCall, StreamTheme } from "@stream-io/video-react-sdk";
import { ShieldAlert } from "lucide-react";

import {
  leaveCallAndReleaseMedia,
  stopLocalTracks,
} from "@/lib/stream/media-teardown";
import { MeetingRoomSkeleton } from "./MeetingRoomSkeleton";
import { useGetCallById } from "./hooks/useGetCallById";
import Alert from "./components/Alert";
import { MeetingLobbyGateCard } from "./components/MeetingLobbyGateCard";
import MeetingSetup from "./components/MeetingSetup";
import MeetingRoom from "./components/MeetingRoom";
import { useSession } from "@/lib/auth-client";

const MeetingPage = () => {
  const { id } = useParams();
  const { data: session, isPending: isSessionPending } = useSession();
  // #1134 P0-2 — access and call resolution are ONE server round-trip now. They
  // used to be two effects racing each other: the call was created client-side
  // before the access check came back, so an unauthorized visitor minted a real
  // Stream call and only then saw "Access Denied".
  const {
    call,
    isCallLoading,
    error,
    access,
    consentRequired,
    roomNotProvisioned,
    rejoin,
    retryJoin,
  } = useGetCallById(id as string);
  const [isSetupComplete, setIsSetupComplete] = useState(false);
  const [isGrantingConsent, setIsGrantingConsent] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);

  const handleGrantConsentAndJoin = async () => {
    if (isGrantingConsent) return;
    setIsGrantingConsent(true);
    setConsentError(null);
    try {
      const response = await fetch("/api/user/privacy/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purposeCodes: ["STREAM_DATA_PROCESSING"] }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : "Could not record your consent. Please try again.",
        );
      }
      retryJoin();
    } catch (err) {
      setConsentError(
        err instanceof Error
          ? err.message
          : "Could not record your consent. Please try again.",
      );
    } finally {
      setIsGrantingConsent(false);
    }
  };

  // Release the camera and microphone on ANY exit from this page, not just the
  // explicit Leave button: navigating away and the browser Back button both
  // unmount the route, and until this ran on those paths too the capture light
  // stayed on after the user had visibly left the meeting.
  useEffect(() => {
    if (!call) return;

    // React does not run effect cleanup when the document itself goes away
    // (tab close, hard navigation), so the tracks are stopped from `pagehide`
    // too. Synchronously: anything awaited here may never resume. Leaving the
    // call properly is skipped — Stream times the participant out, and the
    // camera going dark is the part that cannot wait.
    const onPageHide = (event: PageTransitionEvent) => {
      // `persisted` means the document is going into the back/forward cache,
      // not away: it is frozen with its tree intact and Back restores it.
      // Stopping tracks there leaves the SDK reporting the mic and camera as
      // enabled while nothing is captured, so the meter sits at silence.
      if (event.persisted) return;
      stopLocalTracks(call);
    };
    window.addEventListener("pagehide", onPageHide);

    return () => {
      window.removeEventListener("pagehide", onPageHide);
      void leaveCallAndReleaseMedia(call);
    };
  }, [call]);

  // Loading states — lobby anatomy matches MeetingSetup to avoid spinner flash
  if (isSessionPending || isCallLoading) {
    return <MeetingRoomSkeleton />;
  }

  // Not logged in
  if (!session?.user) {
    return <Alert title="You need to be logged in to join this meeting" />;
  }

  // Inline 1-click DPDP consent prompt when STREAM_DATA_PROCESSING consent is missing
  if (access && !access.hasAccess && consentRequired) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-muted p-4">
        <div
          data-testid="stream-consent-prompt"
          className="w-full max-w-md bg-card p-8 rounded-2xl shadow-xl border border-border text-center"
        >
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-amber-100 flex items-center justify-center">
            <ShieldAlert className="w-8 h-8 text-amber-600" />
          </div>
          <h2 className="text-xl font-bold text-foreground mb-2">
            Enable Live Video &amp; Audio Processing
          </h2>
          <p className="text-muted-foreground mb-3">{access.message}</p>
          <p className="text-sm text-muted-foreground/80 mb-6">
            Under India&apos;s DPDP Act, we need your consent to process live
            video, audio, and session metadata via our real-time media provider
            so you can join this session.
          </p>
          {consentError && (
            <p className="mb-4 text-sm text-red-600" role="alert">
              {consentError}
            </p>
          )}
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={handleGrantConsentAndJoin}
              disabled={isGrantingConsent}
              data-testid="grant-stream-consent-button"
              className="w-full px-6 py-2.5 bg-foreground text-background rounded-lg font-medium hover:bg-foreground/90 transition-colors disabled:opacity-50"
            >
              {isGrantingConsent
                ? "Granting Consent…"
                : "Grant Consent & Join Session"}
            </button>
            <button
              type="button"
              onClick={() => window.history.back()}
              className="w-full px-6 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Go Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Access refused (too early, session concluded, or unauthorized)
  if (access && !access.hasAccess) {
    return (
      <MeetingLobbyGateCard
        meetingId={id as string}
        access={access}
        onRetryJoin={retryJoin}
      />
    );
  }

  if (error) {
    return (
      <Alert
        title="Meeting Error"
        description={`Failed to load meeting: ${error.message}`}
        onRetry={roomNotProvisioned ? retryJoin : undefined}
      />
    );
  }

  if (!call) {
    return (
      <Alert
        title="Meeting Not Found"
        description="The meeting you're trying to join doesn't exist or has ended."
      />
    );
  }

  return (
    <main className="h-screen w-full">
      <StreamCall call={call}>
        <StreamTheme>
          {!isSetupComplete ? (
            <MeetingSetup
              setIsSetupComplete={setIsSetupComplete}
              meetingId={id as string}
              role={access?.role ?? null}
            />
          ) : (
            <MeetingRoom onRejoin={rejoin} role={access?.role ?? null} />
          )}
        </StreamTheme>
      </StreamCall>
    </main>
  );
};

export default MeetingPage;
