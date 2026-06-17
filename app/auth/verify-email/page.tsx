"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { sendVerificationEmail, useSession } from "@/lib/auth-client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

export default function VerifyEmail() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-900">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white" />
        </div>
      }
    >
      <VerifyEmailContent />
    </Suspense>
  );
}

// Friendly copy for the error codes BetterAuth appends to the callbackURL when
// the verification link is bad (see api/routes/email-verification redirectOnError).
function errorMessage(code: string | null): string | null {
  if (!code) return null;
  if (code === "TOKEN_EXPIRED")
    return "That verification link has expired. Request a fresh one below.";
  if (code === "INVALID_TOKEN")
    return "That verification link is invalid. Request a fresh one below.";
  return "We couldn't verify that link. Request a fresh one below.";
}

function VerifyEmailContent() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, isPending } = useSession();
  const error = errorMessage(searchParams.get("error"));
  const [email, setEmail] = useState("");
  const [resending, setResending] = useState(false);

  // Success path: after the link is clicked, BetterAuth verifies + auto-signs-in
  // (autoSignInAfterVerification) and redirects here authenticated. Send the
  // user on to onboarding — the referral capture (if any) is applied there.
  useEffect(() => {
    if (!isPending && session?.user) {
      router.replace(
        session.user.onboardingCompleted ? "/dashboard" : "/form/onboarding",
      );
    }
  }, [isPending, session, router]);

  const handleResend = async () => {
    if (!email || !email.includes("@")) {
      toast({ title: "Enter your email address", variant: "destructive" });
      return;
    }
    setResending(true);
    try {
      await sendVerificationEmail({ email, callbackURL: "/auth/verify-email" });
      toast({
        title: "Verification email sent",
        description: `Check ${email} for the link. It expires in 1 hour.`,
      });
    } catch {
      toast({
        title: "Couldn't send the email",
        description: "Please try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setResending(false);
    }
  };

  if (isPending || session?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="text-center text-white">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto mb-4" />
          <p className="text-sm text-gray-300">
            {session?.user ? "Email verified — redirecting…" : "Loading…"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 p-6">
      <div className="w-full max-w-md text-white">
        <h1 className="text-2xl md:text-3xl font-semibold mb-3">
          {error ? "Link expired or invalid" : "Verify your email"}
        </h1>
        <p className="text-sm md:text-base text-gray-300 mb-6">
          {error ??
            "Check your inbox for the verification link we sent. It expires in 1 hour. Enter your email below to send a new one."}
        </p>

        <div className="grid gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="name@example.com"
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={resending}
          />
        </div>
        <Button
          type="button"
          className="w-full mt-4 bg-gray-800 hover:bg-gray-700"
          onClick={handleResend}
          disabled={resending}
        >
          {resending ? "Sending…" : "Resend verification email"}
        </Button>

        <p className="text-xs text-gray-400 mt-6">
          Already verified?{" "}
          <Link
            href="/auth/signin"
            className="font-medium text-blue-400 hover:underline"
          >
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
