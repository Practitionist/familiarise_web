"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";

import { useRecordingConsentDecision } from "../hooks/useRecordingConsentDecision";

/** In-call 1:1 decline: stops the running recording and has it discarded. */
export default function DeclineRecordingButton({ callId }: { callId: string }) {
  const { toast } = useToast();
  const { submit, pending } = useRecordingConsentDecision(callId);
  const [open, setOpen] = useState(false);
  const [declined, setDeclined] = useState(false);

  if (declined) return null;

  const confirm = async () => {
    const result = await submit("DECLINED");
    if (!result) return;
    if (!result.ok) {
      toast({
        title: "Could not stop the recording",
        description: result.error,
        variant: "destructive",
      });
      return;
    }
    // The hook already told the decliner a stopped recording will be discarded.
    if (!result.recordingStopped) {
      toast({
        title: "Recording declined",
        description: "Your consultant can no longer record this session.",
      });
    }
    setOpen(false);
    setDeclined(true);
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) setOpen(next);
      }}
    >
      <AlertDialogTrigger asChild>
        <button
          type="button"
          className="rounded-lg border border-red-500/30 px-3 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
        >
          Stop recording me
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop recording this session?</AlertDialogTitle>
          <AlertDialogDescription>
            The recording stops for everyone straight away, and everything
            captured so far is discarded. Your consultant will not receive any
            recording of this session, and it cannot be restarted. You stay in
            the call.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            Keep recording
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              void confirm();
            }}
          >
            {pending && (
              <Loader2
                className="mr-2 h-4 w-4 animate-spin"
                aria-hidden="true"
              />
            )}
            Stop and discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
