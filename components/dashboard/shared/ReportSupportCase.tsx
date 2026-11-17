"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LifeBuoy, Loader2 } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { useToast } from "@/hooks/use-toast";
import { humanizeEnum } from "@/lib/ui/tone";
import {
  LinkedReportCaseSchema,
  ReportCaseCategorySchema,
  ReportCaseOptionsSchema,
  type LinkedReportCase,
  type ReportCaseCategory,
} from "@/schemas/moderation";
import { formatOperatorInstant } from "@/lib/time/operator-zone";

const CATEGORY_LABEL: Record<ReportCaseCategory, string> = {
  SAFETY_CONCERN: "Safety concern",
  QUALITY_COMPLAINT: "Quality complaint",
  OTHER: "Other",
};

/** Mirrors the ops door's reason floor so the button never submits a 400. */
const MIN_REASON_LENGTH = 5;

const OpenedSchema = z.object({ case: LinkedReportCaseSchema });
const RefusalSchema = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
  existingCase: LinkedReportCaseSchema.optional(),
});

class OpenCaseError extends Error {
  constructor(
    message: string,
    readonly existingCase?: LinkedReportCase,
  ) {
    super(message);
  }
}

export function supportCaseHref(basePath: string, caseId: string): string {
  return `${basePath}/support/c_${caseId}`;
}

/** The "Case FAM-…" link to the case workspace for a report's linked case. */
export function ReportCaseLink({
  basePath,
  supportCase,
}: Readonly<{ basePath: string; supportCase: LinkedReportCase }>) {
  return (
    <Link
      href={supportCaseHref(basePath, supportCase.id)}
      className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-2"
      onClick={(e) => e.stopPropagation()}
    >
      <LifeBuoy className="h-3.5 w-3.5" />
      Case {supportCase.referenceNumber}
    </Link>
  );
}

const formatStartsAt = (iso: string | null) =>
  iso ? formatOperatorInstant(iso) : "No session scheduled";

/** Picks a booking both users share, a category and a reason, and opens the reporter's case. */
export function OpenReportCaseDialog({
  reportId,
  basePath,
  open,
  onOpenChange,
}: Readonly<{
  reportId: string;
  basePath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>) {
  const [appointmentId, setAppointmentId] = useState<string | null>(null);
  const [category, setCategory] = useState<ReportCaseCategory | null>(null);
  const [reason, setReason] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const options = useQuery({
    queryKey: ["staff-moderation-report-case", reportId],
    queryFn: async () => {
      const res = await fetch(`/api/staff/moderation/reports/${reportId}/case`);
      if (!res.ok) throw new Error("Could not load the shared bookings.");
      return ReportCaseOptionsSchema.parse(await res.json());
    },
    enabled: open,
  });

  const openCase = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/api/staff/moderation/reports/${reportId}/case`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            appointmentId,
            category,
            reason: reason.trim(),
          }),
        },
      );
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const refusal = RefusalSchema.safeParse(body);
        throw new OpenCaseError(
          (refusal.success && refusal.data.error) ||
            "Could not open the support case.",
          refusal.success ? refusal.data.existingCase : undefined,
        );
      }
      return OpenedSchema.parse(body).case;
    },
    onSuccess: (opened) => {
      toast({
        title: "Support case opened",
        description: `Case ${opened.referenceNumber} is in the support inbox.`,
      });
      onOpenChange(false);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ["staff-moderation-reports"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["staff-moderation-report-detail", reportId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["staff-moderation-report-case", reportId],
      });
    },
  });

  const refusal =
    openCase.error instanceof OpenCaseError ? openCase.error : null;
  const linked = options.data?.linkedCase ?? refusal?.existingCase ?? null;
  const ready =
    !!appointmentId &&
    !!category &&
    reason.trim().length >= MIN_REASON_LENGTH &&
    !openCase.isPending;

  return (
    <ResponsiveModal open={open} onOpenChange={onOpenChange}>
      <ResponsiveModalContent className="max-w-lg">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Open support case</ResponsiveModalTitle>
          <ResponsiveModalDescription>
            The case is opened for the person who made the report, on the
            booking you pick. The reported message is not copied into it.
          </ResponsiveModalDescription>
        </ResponsiveModalHeader>

        {options.isPending && (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {options.isError && (
          <p className="text-sm text-destructive">
            {options.error.message}{" "}
            <button
              type="button"
              className="underline"
              onClick={() => void options.refetch()}
            >
              Retry
            </button>
          </p>
        )}
        {options.isSuccess && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (ready) openCase.mutate();
            }}
          >
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Booking</legend>
              {options.data.candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  The reporter and the reported user share no booking, so no
                  case can be opened from this report.
                </p>
              ) : (
                options.data.candidates.map((c) => {
                  const mismatch = c.chatMatchesReport === false;
                  const inputId = `report-case-booking-${c.id}`;
                  return (
                    <label
                      key={c.id}
                      htmlFor={inputId}
                      className={`grid grid-cols-[auto_1fr] items-start gap-x-2 rounded-md border p-2 text-sm ${
                        mismatch ? "opacity-60" : "cursor-pointer"
                      }`}
                    >
                      <input
                        id={inputId}
                        type="radio"
                        name="report-case-booking"
                        value={c.id}
                        checked={appointmentId === c.id}
                        disabled={mismatch}
                        onChange={() => setAppointmentId(c.id)}
                        className="row-span-2 mt-1"
                      />
                      <span className="font-medium">
                        {c.title ?? humanizeEnum(c.type)}
                      </span>
                      <span className="col-start-2 text-xs text-muted-foreground">
                        {humanizeEnum(c.type)} · {formatStartsAt(c.startsAt)}
                        {mismatch ? " · not the reported chat" : ""}
                      </span>
                    </label>
                  );
                })
              )}
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Category</legend>
              <div className="flex flex-wrap gap-3">
                {ReportCaseCategorySchema.options.map((value) => (
                  <label
                    key={value}
                    className="flex items-center gap-1.5 text-sm"
                  >
                    <input
                      type="radio"
                      name="report-case-category"
                      value={value}
                      checked={category === value}
                      onChange={() => setCategory(value)}
                    />
                    {CATEGORY_LABEL[value]}
                  </label>
                ))}
              </div>
            </fieldset>

            <div>
              <Label htmlFor="report-case-reason">
                Reason (kept in the audit log)
              </Label>
              <Textarea
                id="report-case-reason"
                className="mt-1"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why does this report need a support case?"
              />
            </div>

            {refusal && (
              <p role="alert" className="text-sm text-destructive">
                {refusal.message}
              </p>
            )}
            {linked && (
              <ReportCaseLink basePath={basePath} supportCase={linked} />
            )}

            <ResponsiveModalFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!ready}>
                {openCase.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Open case
              </Button>
            </ResponsiveModalFooter>
          </form>
        )}
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
}
