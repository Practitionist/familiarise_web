"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { signUp, useSession, sendVerificationEmail } from "@/lib/auth-client";
import { ssoSigninWithGuard } from "@/lib/sso/signin-with-toast";
import { GlobeIcon } from "@/components/auth/auth-icons";
import { SocialLoginButtons } from "@/components/auth/social-login-buttons";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

export default function SignUp() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-900">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white" />
        </div>
      }
    >
      <SignUpContent />
    </Suspense>
  );
}

function SignUpContent() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const referralCode = searchParams.get("ref");
  const callbackUrl = searchParams.get("callbackUrl");
  const { data: session, isPending } = useSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [refCode, setRefCode] = useState(referralCode || "");
  const [ssoCheck, setSsoCheck] = useState<{
    enforceSSO: boolean;
    organizationName: string;
    ssoBody: { providerId: string; domain: string; callbackURL: string };
  } | null>(null);
  const [ssoChecking, setSsoChecking] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);
  const [resending, setResending] = useState(false);

  // Build onboarding URL with optional callbackUrl passthrough (for org invite flow)
  const onboardingUrl = callbackUrl
    ? `/form/onboarding?callbackUrl=${encodeURIComponent(callbackUrl)}`
    : "/form/onboarding";

  // Redirect authenticated users based on onboarding status
  useEffect(() => {
    if (!isPending && session?.user) {
      if (session.user.onboardingCompleted) {
        // If there's a callbackUrl (e.g., from an invite link), honor it
        if (callbackUrl?.startsWith("/") && !callbackUrl.startsWith("//")) {
          router.push(callbackUrl);
        } else {
          router.push("/dashboard");
        }
      } else {
        router.push(onboardingUrl);
      }
    }
  }, [session, isPending, router, callbackUrl, onboardingUrl]);

  // Show loading while checking session status (fallback for when middleware doesn't catch)
  if (isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white" />
      </div>
    );
  }

  // If already logged in, show redirecting message
  if (session?.user) {
    const destination = session.user.onboardingCompleted
      ? "dashboard"
      : "onboarding";
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <p className="text-white">Redirecting to {destination}...</p>
      </div>
    );
  }

  const handleResendVerification = async () => {
    setResending(true);
    try {
      await sendVerificationEmail({ email, callbackURL: "/auth/verify-email" });
      toast({
        title: "Verification email sent",
        description: `Check ${email} for the link.`,
      });
    } catch {
      toast({
        title: "Couldn't resend the email",
        description: "Please try again in a moment.",
        variant: "destructive",
      });
    } finally {
      setResending(false);
    }
  };

  // After a verification-required signup there is no session yet — show a
  // check-your-email panel with a resend instead of the form.
  if (verificationSent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900 p-6">
        <div className="w-full max-w-md text-center text-white">
          <h2 className="text-2xl md:text-3xl font-semibold mb-3">
            Check your email
          </h2>
          <p className="text-sm md:text-base text-gray-300 mb-6">
            We sent a verification link to{" "}
            <span className="font-medium">{email}</span>. Click it to activate
            your account. The link expires in 1 hour.
          </p>
          <Button
            onClick={handleResendVerification}
            disabled={resending}
            className="w-full bg-gray-800 hover:bg-gray-700"
          >
            {resending ? "Resending…" : "Resend verification email"}
          </Button>
          <p className="text-xs text-gray-400 mt-4">
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

  const handleEmailBlur = async () => {
    if (!email || !email.includes("@")) return;
    setSsoChecking(true);
    try {
      const res = await fetch(`/api/auth/sso/domain-check?email=${encodeURIComponent(email)}`);
      if (res.ok) {
        const data = await res.json();
        setSsoCheck(data.enforceSSO ? {
          enforceSSO: true,
          organizationName: data.organizationName,
          ssoBody: data.ssoBody,
        } : null);
      }
    } catch {
      // ignore — fall through to normal signup
    } finally {
      setSsoChecking(false);
    }
  };

  /**
   * Translate BetterAuth's developer-facing validation errors into
   * user-friendly messages. Raw errors look like:
   *   "[body.email] Invalid email address; [body.password] Too small: ..."
   */
  const handleSSOSignIn = async () => {
    if (!ssoCheck) return;
    // Use the guarded wrapper around signIn.sso() so SSO failures
    // (resolve-with-error, 500-with-empty-body, no-redirect-after-2s)
    // surface as a destructive toast instead of a silent dead-end on
    // the signup form. See `lib/sso/signin-with-toast.ts` + audit B.1.
    const result = await ssoSigninWithGuard({
      providerId: ssoCheck.ssoBody.providerId,
      domain: ssoCheck.ssoBody.domain,
      callbackURL: ssoCheck.ssoBody.callbackURL,
    });
    if (!result.ok && result.errorMessage) {
      toast({
        title: "SSO sign-in failed",
        description: result.errorMessage,
        variant: "destructive",
      });
    }
  };

  const friendlyAuthError = (raw: string | undefined): string => {
    if (!raw) return "An unexpected error occurred. Please try again.";
    const lower = raw.toLowerCase();
    const issues: string[] = [];
    if (lower.includes("email") && (lower.includes("invalid") || lower.includes("required")))
      issues.push("Please enter a valid email address.");
    if (lower.includes("password") && (lower.includes("too small") || lower.includes(">=") || lower.includes("required")))
      issues.push("Password must be at least 8 characters.");
    if (lower.includes("already") || lower.includes("exists"))
      return "An account with this email already exists. Try signing in instead.";
    if (issues.length > 0) return issues.join(" ");
    // Strip "[body.field]" prefixes for anything we didn't catch
    return raw.replace(/\[body\.\w+\]\s*/g, "").trim() || "An unexpected error occurred.";
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    setIsLoading(true);
    toast({ title: "Creating account..." });

    try {
      const { data, error } = await signUp.email({
        name,
        email,
        password,
        callbackURL: "/auth/verify-email",
      });

      if (error) {
        toast({
          title: "Sign Up Failed",
          description: friendlyAuthError(error.message),
          variant: "destructive",
        });
      } else if (data && !data.token) {
        // requireEmailVerification: the account is created but no session is
        // issued until the email is verified. Show the check-your-email panel.
        setVerificationSent(true);
        toast({
          title: "Check your email",
          description: `We sent a verification link to ${email}.`,
        });
      } else if (data) {
        // Session created (verification-disabled fallback): apply referral now.
        if (refCode) {
          try {
            await fetch("/api/referrals/apply", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code: refCode }),
            });
          } catch {
            // Non-blocking: referral application failure shouldn't block signup
          }
        }
        toast({
          title: "Account Created Successfully!",
          description: "Redirecting to onboarding...",
        });
        router.push(onboardingUrl);
      }
    } catch (error: unknown) {
      console.error("Sign up error:", error);
      const message =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred.";
      toast({
        title: "Sign Up Failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row h-full">
      {/* Left Panel */}
      <div className="flex-1 md:w-1/2 bg-white text-black p-6 md:p-12 flex flex-col justify-between">
        <Link href="/">
          <div className="flex items-center justify-start space-x-2">
            <GlobeIcon className="text-black w-5 md:w-6 h-5 md:h-6" />
            <h1 className="text-2xl md:text-4xl font-semibold">Familiarise</h1>
          </div>
        </Link>
        <div className="my-8 md:my-0">
          <blockquote className="text-sm md:text-base">
            "Joining Familiarise was the best decision for my startup. Access to
            top-tier mentors gave us the clarity and direction we desperately
            needed."
          </blockquote>
          <p className="mt-4 text-sm md:text-base">
            Priya Sharma, Founder @ TechNova
          </p>
        </div>
        <div className="text-xs md:text-sm">
          Start your journey with Familiarise today. Sign up to unlock a world
          of expert mentorship.
        </div>
      </div>

      {/* Right Panel (Sign Up Form) */}
      <div className="flex-1 md:w-1/2 bg-gray-900 text-white p-6 md:p-12 flex flex-col justify-center mt-auto md:mt-0">
        <div className="flex flex-col p-4 md:p-20">
          <h2 className="text-2xl md:text-3xl font-semibold mb-4 md:mb-6">
            Create your account
          </h2>
          <p className="text-sm md:text-base mb-4 md:mb-6">
            Enter your details below to get started.
          </p>
          <form onSubmit={handleSignUp}>
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="Your Name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                disabled={isLoading}
              />
            </div>
            <div className="grid gap-2 mt-4">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                placeholder="name@example.com"
                type="email"
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={handleEmailBlur}
                required
                disabled={isLoading || ssoChecking}
              />
            </div>
            {!ssoCheck?.enforceSSO && (
              <>
                <div className="grid gap-2 mt-4">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    disabled={isLoading}
                  />
                </div>
                <div className="grid gap-2 mt-4">
                  <Label htmlFor="confirm-password">Confirm Password</Label>
                  <Input
                    id="confirm-password"
                    type="password"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    disabled={isLoading}
                  />
                </div>
              </>
            )}
            {!referralCode && !ssoCheck?.enforceSSO && (
              <div className="grid gap-2 mt-4">
                <Label htmlFor="referral-code">Referral Code (optional)</Label>
                <Input
                  id="referral-code"
                  placeholder="Enter referral code"
                  type="text"
                  value={refCode}
                  onChange={(e) => setRefCode(e.target.value)}
                  disabled={isLoading}
                />
              </div>
            )}
            {referralCode && !ssoCheck?.enforceSSO && (
              <div className="mt-4 p-3 rounded-md bg-green-900/30 border border-green-700">
                <p className="text-sm text-green-400">
                  Referral code{" "}
                  <span className="font-semibold">{referralCode}</span> applied!
                  You&apos;ll receive a welcome bonus after signing up.
                </p>
              </div>
            )}
            {!ssoCheck?.enforceSSO && (
              <Button
                type="submit"
                className="w-full mt-4 bg-gray-800 hover:bg-gray-700"
                disabled={isLoading}
              >
                {isLoading ? "Creating Account..." : "Create Account"}
              </Button>
            )}
          </form>

          {ssoCheck?.enforceSSO && (
            <div className="mt-4 p-4 rounded-md bg-blue-900/30 border border-blue-700">
              <p className="text-sm text-blue-300 mb-3">
                Your organization requires SSO sign-in. Use the button below to authenticate.
              </p>
              <Button
                type="button"
                className="w-full bg-blue-600 hover:bg-blue-500"
                onClick={handleSSOSignIn}
              >
                Sign in with {ssoCheck.organizationName} SSO &rarr;
              </Button>
            </div>
          )}

          {!ssoCheck?.enforceSSO && (
            <>
              <div className="relative my-4 md:my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-600" />
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="px-2 bg-gray-900 text-gray-400">
                    OR CONTINUE WITH
                  </span>
                </div>
              </div>

              <SocialLoginButtons
                callbackURL={callbackUrl || "/dashboard"}
                newUserCallbackURL={onboardingUrl}
                isLoading={isLoading}
                ssoEnforced={false}
              />
            </>
          )}

          <p className="text-xs text-gray-400 mt-4 md:mt-6">
            Already have an account?{" "}
            <Link
              href="/auth/signin"
              className="font-medium text-blue-400 hover:underline"
            >
              Sign in
            </Link>
          </p>
          <p className="text-xs text-gray-400 mt-2">
            By clicking Create Account, you agree to our Terms of Service and
            Privacy Policy.
          </p>
        </div>
      </div>
    </div>
  );
}
