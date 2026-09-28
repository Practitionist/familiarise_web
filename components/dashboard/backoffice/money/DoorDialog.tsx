"use client";

import { useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ReasonDialog } from "./ReasonDialog";
import { useOpsDoor } from "./ops-door";

/** One console door: where it posts, its copy, and any fields it asks for. */
export type Door = {
  url: string;
  title: string;
  description: string;
  confirm: string;
  body?: Record<string, unknown>;
  /** The make-up door also asks for a start time and the window bypass. */
  extra?: "make-up";
};

/** #1771 K-6 — the reason-gated dialog behind every class and sweep door. */
export function DoorDialog({
  door,
  invalidate,
  onClose,
}: Readonly<{
  door: Door | null;
  invalidate: readonly (readonly unknown[])[];
  onClose: () => void;
}>) {
  const [startsAt, setStartsAt] = useState("");
  const [bypass, setBypass] = useState(false);
  const mutation = useOpsDoor({ success: "Done", invalidate, onDone: onClose });
  if (!door) return null;
  const isMakeUp = door.extra === "make-up";
  const extraBody = (): Record<string, unknown> =>
    isMakeUp
      ? { startsAt: new Date(startsAt).toISOString(), bypassWindow: bypass }
      : {};
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={door.title}
      description={door.description}
      confirmLabel={door.confirm}
      pending={mutation.isPending}
      canConfirm={!isMakeUp || startsAt !== ""}
      onConfirm={(reason) =>
        mutation.mutate({
          url: door.url,
          body: { ...door.body, ...extraBody(), reason },
        })
      }
    >
      {isMakeUp && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="makeup-at">Make-up starts at</Label>
            <Input
              id="makeup-at"
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="makeup-bypass"
              checked={bypass}
              onCheckedChange={(c) => setBypass(c === true)}
            />
            <Label htmlFor="makeup-bypass">
              Allow a date past the 14-day window
            </Label>
          </div>
        </>
      )}
    </ReasonDialog>
  );
}
