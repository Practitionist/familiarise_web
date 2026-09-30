"use client";

import { useState } from "react";
import { FileDown, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BrochurePlanType } from "@/lib/pdf/plan-brochure-data";
import { cn } from "@/utils/tailwind";

export interface PlanBrochureDownloadProps {
  planId: string;
  planType: BrochurePlanType;
  label?: string;
  className?: string;
}

export function PlanBrochureDownload({
  planId,
  planType,
  label = "Download brochure (PDF)",
  className,
}: Readonly<PlanBrochureDownloadProps>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function download() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(
        `/api/plans/${planType}/${encodeURIComponent(planId)}/brochure`,
      );
      if (
        !response.ok ||
        !response.headers.get("Content-Type")?.includes("application/pdf")
      ) {
        setError(
          response.status === 429
            ? "Too many downloads. Please try again in a minute."
            : "Couldn’t prepare the PDF. Please try again.",
        );
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download =
        response.headers
          .get("Content-Disposition")
          ?.match(/filename="([^"]+)"/)?.[1] ?? "familiarise-brochure.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError("Couldn’t prepare the PDF. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <Button
        type="button"
        variant="outline"
        className={cn(
          "h-auto min-h-10 rounded-xl border-border bg-background text-foreground hover:bg-muted whitespace-normal text-left",
          className,
        )}
        onClick={download}
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? (
          <LoaderCircle className="mr-2 h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" />
        ) : (
          <FileDown className="mr-2 h-4 w-4 shrink-0" />
        )}
        {pending ? "Preparing PDF…" : label}
      </Button>
      {error && (
        <p role="alert" className="mt-2 max-w-sm text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
