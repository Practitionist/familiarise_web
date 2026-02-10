"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { signIn, signUp, useSession } from "@/lib/auth-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";

export default function SignUp() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const referralCode = searchParams.get("ref");
  const { data: session, isPending } = useSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [refCode, setRefCode] = useState(referralCode || "");

  // Redirect authenticated users based on onboarding status
  useEffect(() => {
    if (!isPending && session?.user) {
      if (session.user.onboardingCompleted) {
        router.push("/dashboard");
      } else {
        router.push("/form/onboarding");
      }
    }
  }, [session, isPending, router]);

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
      });

      if (error) {
        toast({
          title: "Sign Up Failed",
          description: error.message || "An unexpected error occurred.",
          variant: "destructive",
        });
      } else if (data) {
        // Apply referral code if present
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
        router.push("/form/onboarding");
      }
    } catch (error: any) {
      console.error("Sign up error:", error);
      toast({
        title: "Sign Up Failed",
        description: error?.message || "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col md:flex-row h-full">
      {/* Left Panel - Can be similar to SignIn or customized */}
      <div className="flex-1 md:w-1/2 bg-white text-black p-6 md:p-12 flex flex-col justify-between">
        <Link href="/">
          <div className="flex items-center justify-start space-x-2">
            {/* Reusing GlobeIcon from SignIn */}
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
                required
                disabled={isLoading}
              />
            </div>
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
            {!referralCode && (
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
            {referralCode && (
              <div className="mt-4 p-3 rounded-md bg-green-900/30 border border-green-700">
                <p className="text-sm text-green-400">
                  Referral code <span className="font-semibold">{referralCode}</span> applied! You&apos;ll receive a welcome bonus after signing up.
                </p>
              </div>
            )}
            <Button
              type="submit"
              className="w-full mt-4 bg-gray-800 hover:bg-gray-700"
              disabled={isLoading}
            >
              {isLoading ? "Creating Account..." : "Create Account"}
            </Button>
          </form>

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

          <Button
            className="w-full flex items-center justify-center bg-black hover:bg-gray-700"
            disabled={isLoading}
            onClick={() => {
              signIn.social({ provider: "github", callbackURL: "/dashboard" });
              toast({
                title: "Signing up with GitHub...",
                description: "Please wait while we redirect you.",
              });
            }}
          >
            <GithubIcon className="w-6 h-6 text-white mr-2" />
            Github
          </Button>
          <Button
            className="w-full flex items-center justify-center mt-4 bg-red-600 hover:bg-red-500"
            disabled={isLoading}
            onClick={() => {
              signIn.social({ provider: "google", callbackURL: "/dashboard" });
              toast({
                title: "Signing up with Google...",
                description: "Please wait while we redirect you.",
              });
            }}
          >
            <ChromeIcon className="w-6 h-6 text-white mr-2" />
            Google
          </Button>
          <Button
            className="w-full flex items-center justify-center mt-4 bg-blue-600 hover:bg-blue-500"
            disabled={isLoading}
            onClick={() => {
              signIn.social({
                provider: "facebook",
                callbackURL: "/dashboard",
              });
              toast({
                title: "Signing up with Facebook...",
                description: "Please wait while we redirect you.",
              });
            }}
          >
            <FacebookIcon className="w-6 h-6 text-white mr-2" />
            Facebook
          </Button>

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

function GlobeIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="2" x2="22" y1="12" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

function GithubIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}

function ChromeIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="4" />
      <line x1="21.17" x2="12" y1="8" y2="8" />
      <line x1="3.95" x2="8.54" y1="6.06" y2="14" />
      <line x1="10.88" x2="15.46" y1="21.94" y2="14" />
    </svg>
  );
}

function FacebookIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
    </svg>
  );
}
