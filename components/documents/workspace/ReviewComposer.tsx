"use client";

import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { uploadBookingFile } from "@/lib/documents/direct-upload";
import {
  FileActionError,
  friendlyErrorFromResponse,
  friendlyFileError,
} from "@/lib/documents/file-errors";
import {
  FILE_ACCEPT_ATTR,
  FILE_POLICY_HINT,
  validateUploadFile,
} from "@/lib/documents/file-policy";

const ReviewChoiceSchema = z.enum([
  "IN_REVIEW",
  "NEEDS_REVISION",
  "APPROVED",
  "REJECTED",
]);
type ReviewChoice = z.infer<typeof ReviewChoiceSchema>;

const CHOICES: { value: ReviewChoice; label: string }[] = [
  { value: "IN_REVIEW", label: "Start review" },
  { value: "NEEDS_REVISION", label: "Needs revision" },
  { value: "APPROVED", label: "Approve" },
  { value: "REJECTED", label: "Not accepted" },
];

/**
 * The expert's review of the latest learner version: a status, feedback and an
 * optional reply file, sent as one request so status and reply land together.
 */
export function ReviewComposer({
  appointmentId,
  documentId,
  versionNo,
  currentStatus,
  onDone,
}: Readonly<{
  appointmentId: string;
  documentId: string;
  versionNo: number;
  currentStatus: string | null;
  onDone: () => void;
}>) {
  const { toast } = useToast();
  const groupId = useId();
  const fileId = useId();
  const [choice, setChoice] = useState<ReviewChoice | null>(null);
  const [notes, setNotes] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: async () => {
      const reply = file
        ? await uploadBookingFile({
            appointmentId,
            file,
            parentDocumentId: documentId,
          })
        : undefined;
      let res: Response;
      try {
        res = await fetch(
          `/api/appointments/${encodeURIComponent(appointmentId)}/documents/${encodeURIComponent(documentId)}/review`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...(choice && choice !== currentStatus
                ? { reviewStatus: choice }
                : {}),
              ...(notes.trim() ? { reviewNotes: notes.trim() } : {}),
              ...(reply ? { reply } : {}),
            }),
          },
        );
      } catch {
        throw new FileActionError(friendlyFileError("NETWORK"));
      }
      if (!res.ok) {
        throw new FileActionError(
          await friendlyErrorFromResponse(res, { role: "consultant" }),
        );
      }
    },
    onSuccess: () => {
      setChoice(null);
      setNotes("");
      setFile(null);
      toast({ title: "Feedback sent" });
      onDone();
    },
    onError: (error) => {
      const copy =
        error instanceof FileActionError
          ? { title: error.title, description: error.message }
          : friendlyFileError("SERVER_ERROR");
      toast({
        title: copy.title,
        description: copy.description,
        variant: "destructive",
      });
      onDone();
    },
  });

  const canSend =
    (choice !== null && choice !== currentStatus) ||
    notes.trim().length > 0 ||
    file !== null;

  return (
    <form
      className="space-y-3 rounded-lg border border-border bg-muted/20 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) submit.mutate();
      }}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Review v{versionNo}
      </p>
      <RadioGroup
        aria-labelledby={groupId}
        value={choice ?? ""}
        onValueChange={(v) => {
          const parsed = ReviewChoiceSchema.safeParse(v);
          if (parsed.success) setChoice(parsed.data);
        }}
        className="flex flex-wrap gap-x-4 gap-y-2"
      >
        <span id={groupId} className="sr-only">
          Review outcome
        </span>
        {CHOICES.filter((c) => c.value !== currentStatus).map((c) => (
          <div key={c.value} className="flex items-center gap-1.5">
            <RadioGroupItem value={c.value} id={`${groupId}-${c.value}`} />
            <Label htmlFor={`${groupId}-${c.value}`} className="text-sm">
              {c.label}
            </Label>
          </div>
        ))}
      </RadioGroup>
      <div className="space-y-1">
        <Label htmlFor={`${groupId}-notes`} className="text-xs">
          Feedback
        </Label>
        <Textarea
          id={`${groupId}-notes`}
          value={notes}
          maxLength={2000}
          onChange={(e) => setNotes(e.target.value)}
          className="min-h-[72px] text-sm"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={fileId} className="text-xs">
          Attach a reply file (optional) — it becomes the next version, labelled
          &ldquo;Expert reply&rdquo;
        </Label>
        <input
          id={fileId}
          type="file"
          accept={FILE_ACCEPT_ATTR}
          className="block w-full text-xs"
          onChange={(e) => {
            const picked = e.target.files?.[0] ?? null;
            if (!picked) {
              setFile(null);
              return;
            }
            const policy = validateUploadFile(picked);
            if (!policy.ok) {
              setFileError(friendlyFileError(policy.code).description);
              setFile(null);
              e.target.value = "";
              return;
            }
            setFileError(null);
            setFile(picked);
          }}
        />
        <p className="text-[11px] text-muted-foreground">{FILE_POLICY_HINT}</p>
        {fileError && (
          <p role="alert" className="text-xs text-destructive">
            {fileError}
          </p>
        )}
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!canSend || submit.isPending}>
          {submit.isPending ? "Sending…" : "Send feedback"}
        </Button>
      </div>
    </form>
  );
}
