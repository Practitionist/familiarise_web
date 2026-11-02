"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";
import { invalidateSupportCase } from "@/lib/support/support-keys";

export function CaseCsat({
  caseId,
  status,
  resolvedAt,
  rating,
}: Readonly<{
  caseId: string;
  status: string;
  resolvedAt?: string | null;
  rating?: number | null;
}>) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [choice, setChoice] = useState<number | null>(null);
  const effective = choice ?? rating ?? null;
  const submit = useMutation({
    mutationFn: async (score: number) => {
      const response = await fetch(`/api/support/cases/${caseId}/csat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: score }),
      });
      if (!response.ok) await throwSupportError(response, "support rating");
      return score;
    },
    onSuccess: (score) => {
      setChoice(score);
      void invalidateSupportCase(qc, caseId);
    },
    onError: (error: unknown) => {
      toast({
        title: "Your rating was not saved",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
      void invalidateSupportCase(qc, caseId);
    },
  });
  const elapsed = resolvedAt
    ? Date.now() - new Date(resolvedAt).getTime()
    : Infinity;
  if (
    !["RESOLVED", "CLOSED"].includes(status) ||
    elapsed < 0 ||
    elapsed > 28 * 86_400_000
  )
    return null;
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs">
      <p className="font-medium text-foreground">
        {effective
          ? "Thanks for rating how we handled your request."
          : "How did our support team do on this support case?"}
      </p>
      <div className="mt-1.5 flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((score) => (
          <Button
            key={score}
            type="button"
            size="sm"
            variant={effective === score ? "default" : "outline"}
            className="h-7 w-7 p-0 text-xs"
            aria-label={`Rate support ${score} out of 5`}
            disabled={submit.isPending || effective !== null}
            onClick={() => submit.mutate(score)}
          >
            {score}★
          </Button>
        ))}
      </div>
    </div>
  );
}
