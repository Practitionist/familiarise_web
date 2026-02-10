"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { authClient } from "@/lib/auth-client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, Suspense } from "react";

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-gray-900">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white" />
        </div>
      }
    >
      <ResetPasswordContent />
    </Suspense>
  );
}

function ResetPasswordContent() {
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setError("Invalid or missing password reset token.");
      toast({
        title: "Error",
        description: "Invalid or missing password reset token.",
        variant: "destructive",
      });
      // Auto-redirect to forgot-password after 3 seconds
      const timer = setTimeout(() => {
        router.push("/auth/forgot-password");
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [token, router, toast]);

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) {
      setError("Invalid or missing password reset token.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }

    setIsLoading(true);
    setMessage("");
    setError("");
    toast({ title: "Resetting password..." });

    try {
      const { error: resetError } = await authClient.resetPassword({
        newPassword: password,
        token,
      });
      if (resetError) {
        setError(resetError.message || "An unexpected error occurred.");
        toast({
          title: "Error Resetting Password",
          description: resetError.message || "An unexpected error occurred.",
          variant: "destructive",
        });
      } else {
        const successMessage = "Password has been reset successfully.";
        setMessage(successMessage);
        toast({ title: "Success", description: successMessage });
        setTimeout(() => router.push("/auth/signin"), 3000);
      }
    } catch (err: any) {
      console.error("Reset password error:", err);
      const errorMessage = err?.message || "An unexpected error occurred.";
      setError(errorMessage);
      toast({
        title: "Error Resetting Password",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-950">
      <div className="w-full max-w-md p-8 space-y-6 bg-white rounded-lg shadow-md dark:bg-gray-900">
        <div className="text-center">
          {/* Reusing GlobeIcon style from SignIn */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mx-auto h-12 w-auto text-gray-900 dark:text-gray-100"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="2" x2="22" y1="12" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          <h2 className="mt-6 text-3xl font-extrabold text-gray-900 dark:text-white">
            Reset Your Password
          </h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            Enter your new password below.
          </p>
        </div>

        {error && !token && (
          <div
            className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative"
            role="alert"
          >
            <strong className="font-bold">Error!</strong>
            <span className="block sm:inline"> {error}</span>
            <p className="mt-2 text-sm">
              Redirecting to the{" "}
              <Link
                href="/auth/forgot-password"
                className="font-medium text-red-800 hover:underline"
              >
                forgot password page
              </Link>{" "}
              in 3 seconds...
            </p>
          </div>
        )}

        {token && (
          <form className="space-y-6" onSubmit={handleResetPassword}>
            <div>
              <Label htmlFor="password">New Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                className="mt-1 appearance-none rounded-md relative block w-full px-3 py-2 border border-gray-300 dark:border-gray-700 placeholder-gray-500 dark:placeholder-gray-400 text-gray-900 dark:text-white focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                placeholder="New password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading}
              />
            </div>

            <div>
              <Label htmlFor="confirm-password">Confirm New Password</Label>
              <Input
                id="confirm-password"
                name="confirm-password"
                type="password"
                required
                className="mt-1 appearance-none rounded-md relative block w-full px-3 py-2 border border-gray-300 dark:border-gray-700 placeholder-gray-500 dark:placeholder-gray-400 text-gray-900 dark:text-white focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                placeholder="Confirm new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={isLoading}
              />
            </div>

            {error && (
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            )}
            {message && (
              <p className="text-sm text-green-600 dark:text-green-400">
                {message}
              </p>
            )}

            <div>
              <Button
                type="submit"
                className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 dark:bg-indigo-500 dark:hover:bg-indigo-600"
                disabled={isLoading || !!message} // Disable button after success message
              >
                {isLoading ? "Resetting..." : "Reset Password"}
              </Button>
            </div>
          </form>
        )}

        <div className="text-sm text-center">
          <Link
            href="/auth/signin"
            className="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400 dark:hover:text-indigo-300"
          >
            Back to Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}

