"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Building2, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useSession } from "@/lib/auth-client";

interface AcceptResponse {
  organization: { id: string; name: string };
  role?: string;
  alreadyMember?: boolean;
}

/**
 * Public invitation acceptance page.
 *
 * Flow:
 *   1. Unauthenticated → render a CTA pointing to signup with the token
 *      preserved in the query string. Signup auto-redirects back here.
 *   2. Authenticated → POST /api/organizations/invitations/accept with the
 *      token. On success, route to the org dashboard.
 *
 * The route lives outside the dashboard group so middleware doesn't gate it
 * behind a session cookie.
 */
export default function InviteAcceptPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const router = useRouter();
  const { data: session, isPending } = useSession();

  const [status, setStatus] = useState<
    "idle" | "accepting" | "success" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AcceptResponse | null>(null);

  // Store the token in localStorage so new users signing up via this link
  // can be auto-redirected back here after completing onboarding.
  // This bridges the signup → onboarding → dashboard redirect chain where
  // the callbackUrl would otherwise be lost.
  useEffect(() => {
    if (!isPending && !session?.user?.id) {
      try {
        localStorage.setItem("pendingOrgInviteToken", token);
      } catch {
        // localStorage unavailable — fallback to callbackUrl in the links below
      }
    }
  }, [isPending, session, token]);

  useEffect(() => {
    if (isPending) return;
    if (!session?.user?.id) return;
    if (status !== "idle") return;

    setStatus("accepting");
    fetch("/api/organizations/invitations/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) {
          throw new Error(body.error || "Failed to accept invitation");
        }
        return body as AcceptResponse;
      })
      .then((body) => {
        setResult(body);
        setStatus("success");
      })
      .catch((err: Error) => {
        setError(err.message);
        setStatus("error");
      });
  }, [isPending, session, token, status]);

  // Auto-route on success after a brief confirmation flash.
  useEffect(() => {
    if (status === "success" && result) {
      const t = setTimeout(() => {
        router.push(
          `/dashboard/organization/${result.organization.id}/home`,
        );
      }, 1200);
      return () => clearTimeout(t);
    }
  }, [status, result, router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-zinc-100 flex items-center justify-center">
            <Building2 className="w-6 h-6 text-zinc-600" />
          </div>
          <CardTitle>Organization invitation</CardTitle>
          <CardDescription>
            You have been invited to join an organization on Familiarise.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isPending ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
            </div>
          ) : !session?.user?.id ? (
            <div className="text-center space-y-3">
              <p className="text-sm text-zinc-600">
                Sign in or create an account to accept this invitation.
              </p>
              <div className="flex flex-col gap-2">
                <Link
                  href={`/auth/signin?callbackUrl=${encodeURIComponent(
                    `/organizations/invite/${token}`,
                  )}`}
                >
                  <Button className="w-full">Sign in</Button>
                </Link>
                <Link
                  href={`/auth/signup?callbackUrl=${encodeURIComponent(
                    `/organizations/invite/${token}`,
                  )}`}
                >
                  <Button variant="outline" className="w-full">
                    Create account
                  </Button>
                </Link>
              </div>
            </div>
          ) : status === "accepting" || status === "idle" ? (
            <div className="flex flex-col items-center py-6 gap-2">
              <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
              <p className="text-sm text-zinc-500">Accepting invitation…</p>
            </div>
          ) : status === "success" && result ? (
            <div className="text-center space-y-2 py-2">
              <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto" />
              <p className="text-base font-medium text-zinc-900">
                {result.alreadyMember
                  ? "You are already a member"
                  : "You're in!"}
              </p>
              <p className="text-sm text-zinc-500">
                Welcome to {result.organization.name}. Redirecting you now…
              </p>
            </div>
          ) : (
            <div className="text-center space-y-3 py-2">
              <AlertCircle className="h-10 w-10 text-red-500 mx-auto" />
              <p className="text-sm text-zinc-700">
                {error ?? "We could not accept this invitation."}
              </p>
              <Link href="/dashboard">
                <Button variant="outline" size="sm">
                  Go to dashboard
                </Button>
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
