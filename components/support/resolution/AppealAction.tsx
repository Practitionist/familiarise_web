"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { throwSupportError } from "@/lib/support/error-copy";
import { supportKeys } from "@/lib/support/support-keys";

const AppealCreated = z.object({
  data: z.object({ id: z.string(), referenceNumber: z.string().nullable() }),
});

export type AppealTarget =
  { decisionId: string } | { moderationActionId: string };

/** An appeal opened inline under its decision, with focus on the reason and a submitted receipt. */
export function AppealAction({
  target,
  prompt = "Why should this decision be reviewed?",
  onSubmitted,
}: Readonly<{
  target: AppealTarget;
  prompt?: string;
  onSubmitted?: () => void;
}>) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState<{ reference: string | null }>();
  const intakeId = useRef<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) field.current?.focus();
    else if (wasOpen.current && !submitted) trigger.current?.focus();
    wasOpen.current = open;
  }, [open, submitted]);
  const appeal = useMutation({
    mutationFn: async (text: string) => {
      intakeId.current ??= crypto.randomUUID();
      const response = await fetch("/api/support/appeals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...target,
          reason: text,
          clientIntakeId: intakeId.current,
        }),
      });
      if (!response.ok) await throwSupportError(response, "appeal submission");
      return AppealCreated.parse(await response.json()).data;
    },
    onSuccess: (created) => {
      intakeId.current = null;
      setSubmitted({ reference: created.referenceNumber });
      setOpen(false);
      setReason("");
      toast({ title: "Appeal submitted for independent review" });
      void qc.invalidateQueries({ queryKey: supportKeys.requests() });
      void qc.invalidateQueries({ queryKey: supportKeys.evidence() });
      onSubmitted?.();
    },
    onError: (error: unknown) =>
      toast({
        title: "Your appeal was not submitted",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      }),
  });
  if (submitted)
    return (
      <output className="block text-sm text-muted-foreground">
        Appeal submitted
        {submitted.reference ? ` · ${submitted.reference}` : ""}. It will be
        reviewed independently.
      </output>
    );
  if (!open)
    return (
      <Button
        ref={trigger}
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        Appeal this decision
      </Button>
    );
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        const text = reason.trim();
        if (text && !appeal.isPending) appeal.mutate(text);
      }}
    >
      <label htmlFor={fieldId} className="block text-sm font-medium">
        {prompt}
      </label>
      <Textarea
        id={fieldId}
        ref={field}
        value={reason}
        maxLength={10000}
        onChange={(event) => {
          setReason(event.target.value);
          intakeId.current = null;
        }}
        required
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={appeal.isPending || !reason.trim()}>
          {appeal.isPending ? "Submitting…" : "Submit appeal"}
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          disabled={appeal.isPending}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
