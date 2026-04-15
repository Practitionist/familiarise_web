"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { signIn, useSession } from "@/lib/auth-client";
import { GlobeIcon } from "@/components/auth/auth-icons";
import { SocialLoginButtons } from "@/components/auth/social-login-buttons";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, Suspense } from "react";

export default function SignIn() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-900">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white" />
        </div>
      }
    >
      <SignInContent />
    </Suspense>
  );
}

function SignInContent() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, isPending } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState<string | null>(null);
  const [ssoCheck, setSsoCheck] = useState<{
    enforceSSO: boolean;
    organizationName: string;
    ssoBody: { providerId: string; domain: string; callbackURL: string };
  } | null>(null);
  const [ssoChecking, setSsoChecking] = useState(false);

  useEffect(() => {
    const url = searchParams.get("callbackUrl");
    // Only allow relative paths to prevent XSS (e.g. javascript:alert(1))
    if (url && url.startsWith("/") && !url.startsWith("//")) {
      setCallbackUrl(url);
    }
  }, [searchParams]);

  // Redirect authenticated users based on onboarding status
  useEffect(() => {
    if (!isPending && session?.user) {
      if (session.user.onboardingCompleted) {
        router.push(callbackUrl || "/dashboard");
      } else {
        router.push("/form/onboarding");
      }
    }
  }, [session, isPending, router, callbackUrl]);

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
      // ignore — fall through to normal login
    } finally {
      setSsoChecking(false);
    }
  };

  const handleSSOSignIn = async () => {
    if (!ssoCheck) return;
    // Must use signIn.sso() — not a raw fetch — so the ssoClient plugin can
    // generate and persist the OIDC PKCE verifier before the IdP redirect.
    await signIn.sso({
      providerId: ssoCheck.ssoBody.providerId,
      domain: ssoCheck.ssoBody.domain,
      callbackURL: ssoCheck.ssoBody.callbackURL,
    });
  };

  const friendlyAuthError = (raw: string | undefined): string => {
    if (!raw) return "Invalid email or password.";
    const lower = raw.toLowerCase();
    if (lower.includes("email") && (lower.includes("invalid") || lower.includes("required")))
      return "Please enter a valid email address.";
    if (lower.includes("password") && (lower.includes("too small") || lower.includes(">=") || lower.includes("required")))
      return "Please enter your password.";
    if (lower.includes("invalid") && lower.includes("credentials"))
      return "Invalid email or password.";
    if (lower.includes("not found") || lower.includes("no user"))
      return "No account found with this email. Check the address or sign up.";
    return raw.replace(/\[body\.\w+\]\s*/g, "").trim() || "Invalid email or password.";
  };

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    toast({ title: "Signing in..." });

    try {
      const { data, error } = await signIn.email({
        email,
        password,
      });

      if (error) {
        toast({
          title: "Sign In Failed",
          description: friendlyAuthError(error.message),
          variant: "destructive",
        });
      } else if (data) {
        toast({
          title: "Sign In Successful",
          description: callbackUrl
            ? "Redirecting to your destination..."
            : "Redirecting to dashboard...",
        });
        router.push(callbackUrl || "/dashboard");
      }
    } catch (error) {
      console.error("Sign in error:", error);
      toast({
        title: "Sign In Error",
        description: "An unexpected error occurred. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row h-full">
      <div className="flex-1 md:w-1/2 bg-white text-black p-6 md:p-12 flex flex-col justify-between">
        <Link href="/">
          <div className="flex items-center justify-start space-x-2">
            <GlobeIcon className="text-black w-5 md:w-6 h-5 md:h-6" />
            <h1 className="text-2xl md:text-4xl font-semibold">Familiarise</h1>
          </div>
        </Link>
        <div className="my-8 md:my-0">
          <blockquote className="text-sm md:text-base">
            "The mentors on this platform have been incredible. Their deep
            industry expertise and personalized guidance helped me navigate
            complex career decisions and accelerate my professional growth. The
            insights I gained were truly transformative."
          </blockquote>
          <p className="mt-4 text-sm md:text-base">
            Shubham, Software Engineer
          </p>
        </div>
        <div className="text-xs md:text-sm">
          Connect with experienced mentors who can guide you towards your
          professional goals.
        </div>
      </div>
      <div className="flex-1 md:w-1/2 bg-gray-900 text-white p-6 md:p-12 flex flex-col justify-center mt-auto md:mt-0">
        <div className="flex flex-col p-4 md:p-20">
          <h2 className="text-2xl md:text-3xl font-semibold mb-4 md:mb-6">
            Sign in to your account
          </h2>
          {searchParams.get("sso_required") === "1" && (
            <div className="mb-4 p-3 rounded-md bg-yellow-900/40 border border-yellow-600">
              <p className="text-sm text-yellow-300">
                Your organization requires SSO sign-in.
              </p>
            </div>
          )}
          <p className="text-sm md:text-base mb-4 md:mb-6">
            Enter your email and password below to sign in.
          </p>
          <form onSubmit={handleEmailSignIn}>
            <div className="grid gap-2">
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
              <div className="grid gap-2 mt-4">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password">Password</Label>
                  <Link
                    href="/auth/forgot-password"
                    className="text-sm font-medium text-blue-400 hover:underline"
                  >
                    Forgot password?
                  </Link>
                </div>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={isLoading}
                />
              </div>
            )}
            {ssoCheck?.enforceSSO ? (
              <Button
                type="button"
                className="w-full mt-4 bg-blue-600 hover:bg-blue-500"
                onClick={handleSSOSignIn}
              >
                Sign in with {ssoCheck.organizationName} SSO &rarr;
              </Button>
            ) : (
              <Button
                type="submit"
                className="w-full mt-4 bg-gray-800 hover:bg-gray-700"
                disabled={isLoading}
              >
                {isLoading ? "Signing In..." : "Sign In with Email"}
              </Button>
            )}
          </form>
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
                newUserCallbackURL="/form/onboarding"
                isLoading={isLoading}
                ssoEnforced={false}
              />
            </>
          )}
          <p className="text-xs text-gray-400 mt-4 md:mt-6">
            Don't have an account?{" "}
            <Link
              href="/auth/signup"
              className="font-medium text-blue-400 hover:underline"
            >
              Sign up
            </Link>
          </p>
          <p className="text-xs text-gray-400 mt-2">
            By clicking continue, you agree to our Terms of Service and Privacy
            Policy.
          </p>
        </div>
        <div />
      </div>
    </div>
  );
}
