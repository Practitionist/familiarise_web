"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SingleTimePicker,
  type SingleTimeValue,
} from "@/components/scheduling/SingleTimePicker";
import { useToast } from "@/hooks/use-toast";
import { errorMessageFromBody } from "@/lib/fetch-helpers";
import { byCodeUnit } from "@/lib/scheduling/code-unit-order";
import { formatDateTimeLabel } from "@/lib/time/display";
import { useViewerZone } from "@/lib/time/use-viewer-zone";

const ATOM_MS = 30 * 60_000;

export interface AllocateOrgBookingDialogProps {
  orgId: string;
  appointmentId: string;
  planTitle: string;
  expertName?: string | null;
  learnerName?: string | null;
  /** The learner, so their own busy times read as taken. */
  learnerUserId?: string | null;
  /** The delivering expert, whose open hours the times come from. */
  consultantProfileId: string;
  sessionMinutes: number;
  trigger?: React.ReactNode;
  onAllocated?: () => void;
}

export function AllocateOrgBookingDialog({
  orgId,
  appointmentId,
  planTitle,
  expertName,
  learnerName,
  learnerUserId,
  consultantProfileId,
  sessionMinutes,
  trigger,
  onAllocated,
}: Readonly<AllocateOrgBookingDialogProps>) {
  const router = useRouter();
  const { toast } = useToast();
  const { zone } = useViewerZone();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [picked, setPicked] = useState<SingleTimeValue | null>(null);
  const [starts, setStarts] = useState<string[]>([]);
  const [overrideReason, setOverrideReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setMode("auto");
    setPicked(null);
    setStarts([]);
    setOverrideReason("");
    setError(null);
  };

  const handleSubmit = async () => {
    setError(null);
    const trimmedReason = overrideReason.trim();
    if (trimmedReason.length < 5) {
      setError("Please enter an audit justification of at least 5 characters.");
      return;
    }

    let isoSlots: string[] | undefined;
    if (mode === "manual") {
      if (starts.length === 0) {
        setError("Add at least one time for manual allocation.");
        return;
      }
      // Manual allocation takes every 30-minute atom of each session.
      isoSlots = starts
        .flatMap((start) =>
          Array.from({ length: Math.ceil(sessionMinutes / 30) }, (_, i) =>
            new Date(Date.parse(start) + i * ATOM_MS).toISOString(),
          ),
        )
        .sort(byCodeUnit);
    }

    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/appointments/${appointmentId}/allocate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            isAuto: mode === "auto",
            slots: isoSlots,
            overrideReason: trimmedReason,
          }),
        },
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(
          errorMessageFromBody(body, "Could not allocate slots for booking."),
        );
        return;
      }
      toast({
        title: "Slot allocated",
        description: `Scheduled ${planTitle} on behalf of the organization.`,
      });
      reset();
      setOpen(false);
      onAllocated?.();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      {trigger ? (
        <button
          type="button"
          className="inline-flex appearance-none bg-transparent p-0 text-left"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
        >
          {trigger}
        </button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
        >
          <CalendarClock className="mr-1.5 h-3.5 w-3.5" />
          Allocate Slot
        </Button>
      )}

      <ResponsiveModal
        open={open}
        onOpenChange={(next) => {
          if (!next) reset();
          setOpen(next);
        }}
      >
        <ResponsiveModalContent
          className={mode === "manual" ? "sm:max-w-3xl" : "sm:max-w-md"}
        >
          <ResponsiveModalHeader>
            <ResponsiveModalTitle>
              Allocate Slot — {planTitle}
            </ResponsiveModalTitle>
          </ResponsiveModalHeader>

          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Allocate calendar slots on behalf of the organization
              {expertName ? ` with ${expertName}` : ""}
              {learnerName ? ` for ${learnerName}` : ""}. All slots are
              validated against the delivering expert&apos;s availability and
              recorded in the audit log.
            </p>

            <div className="space-y-2">
              <Label>Allocation mode</Label>
              <Select
                value={mode}
                onValueChange={(v) => {
                  if (v === "auto" || v === "manual") setMode(v);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    Auto-allocate from expert&apos;s next available slots
                  </SelectItem>
                  <SelectItem value="manual">
                    Specify exact slot start time(s)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {mode === "manual" && (
              <div className="space-y-3">
                <Label>Session times</Label>
                <SingleTimePicker
                  consultantId={consultantProfileId}
                  consulteeUserId={learnerUserId ?? undefined}
                  sessionMinutes={sessionMinutes}
                  zone={zone}
                  theme="light"
                  audience="buyer"
                  purpose="allocate"
                  value={picked}
                  onChange={setPicked}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!picked || starts.includes(picked.startsAt)}
                  onClick={() => {
                    if (!picked) return;
                    setStarts((prev) => [...prev, picked.startsAt]);
                    setPicked(null);
                  }}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" /> Add this time
                </Button>
                {starts.length > 0 && (
                  <ul className="space-y-1">
                    {starts.map((start) => (
                      <li
                        key={start}
                        className="flex items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm"
                      >
                        {formatDateTimeLabel(new Date(start), { zone })}
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label={`Remove ${formatDateTimeLabel(new Date(start), { zone })}`}
                          onClick={() =>
                            setStarts((prev) => prev.filter((s) => s !== start))
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="allocate-override-reason">
                Audit justification (required)
              </Label>
              <Input
                id="allocate-override-reason"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="e.g. SLA escalation — learner requested immediate scheduling"
              />
              <p className="text-xs text-muted-foreground">
                Recorded on the organization audit log and shared with the
                delivering expert.
              </p>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>

          <ResponsiveModalFooter>
            <Button
              variant="outline"
              onClick={() => {
                reset();
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  Allocating…
                </>
              ) : (
                "Confirm Allocation"
              )}
            </Button>
          </ResponsiveModalFooter>
        </ResponsiveModalContent>
      </ResponsiveModal>
    </>
  );
}
