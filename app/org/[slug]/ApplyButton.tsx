"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ApplyButton({ orgId }: { orgId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">(
    "idle",
  );
  const [message, setMessage] = useState("");

  async function handleApply() {
    setState("loading");
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/consultants/apply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );

      // Unauthenticated: redirect to sign-in with return URL back to this org page.
      if (res.status === 401) {
        const returnTo = encodeURIComponent(pathname);
        router.push(`/auth/signin?callbackUrl=${returnTo}`);
        return;
      }

      const data = await res.json();

      // Not a verified consultant — point them to onboarding.
      if (res.status === 403) {
        setState("error");
        setMessage(
          "You need a verified consultant profile to apply. Complete consultant onboarding first.",
        );
        return;
      }

      // Already a member — friendlier message than the raw conflict.
      if (res.status === 409) {
        setState("error");
        setMessage(
          data.error ?? "You are already a member of this organization.",
        );
        return;
      }

      if (!res.ok) {
        setState("error");
        setMessage(data.error || "Application failed. Please try again.");
      } else {
        setState("success");
        setMessage(data.message || "Application submitted!");
      }
    } catch {
      setState("error");
      setMessage("Something went wrong. Please try again.");
    }
  }

  if (state === "success") {
    return <p className="text-sm text-emerald-600">{message}</p>;
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <Button size="sm" onClick={handleApply} disabled={state === "loading"}>
        {state === "loading" ? (
          <span className="animate-pulse">Applying...</span>
        ) : (
          <>
            <UserPlus className="h-4 w-4 mr-1.5" />
            Apply as Consultant
          </>
        )}
      </Button>
      {state === "error" && (
        <p className="text-xs text-red-500 max-w-xs text-center">{message}</p>
      )}
    </div>
  );
}
