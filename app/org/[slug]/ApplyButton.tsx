"use client";

import { useState } from "react";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ApplyButton({ orgId }: { orgId: string }) {
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
      const data = await res.json();
      if (!res.ok) {
        setState("error");
        setMessage(data.error || "Application failed");
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
        <p className="text-xs text-red-500">{message}</p>
      )}
    </div>
  );
}
