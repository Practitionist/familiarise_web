"use client";

import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FormControl } from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";

import { useWaitingCounts } from "./waiting-count";

/** Turning the waitlist off drops the open rows, so it asks first when anyone is waiting. */
export function WaitlistSwitch({
  checked,
  onCheckedChange,
}: Readonly<{ checked: boolean; onCheckedChange: (next: boolean) => void }>) {
  const waiting = useWaitingCounts().plan;
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <FormControl>
        <Switch
          checked={checked}
          onCheckedChange={(next) => {
            if (!next && (waiting === null || waiting > 0)) setConfirming(true);
            else onCheckedChange(next);
          }}
        />
      </FormControl>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off the waitlist?</AlertDialogTitle>
            <AlertDialogDescription>
              {waiting === null
                ? "Anyone waiting"
                : `${waiting} ${waiting === 1 ? "person" : "people"} waiting`}{" "}
              will no longer be notified. Their entries are removed and are not
              restored if you turn it back on.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep waitlist</AlertDialogCancel>
            <AlertDialogAction onClick={() => onCheckedChange(false)}>
              Turn off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
