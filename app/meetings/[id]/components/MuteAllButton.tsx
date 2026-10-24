"use client";

import { useState } from "react";
import {
  OwnCapability,
  useCall,
  useCallStateHooks,
} from "@stream-io/video-react-sdk";
import { MicOff } from "lucide-react";

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

/** Host control that mutes every participant's microphone after a confirm; Stream enforces the capability again server-side. */
export function MuteAllButton() {
  const call = useCall();
  const { toast } = useToast();
  const { useHasPermissions } = useCallStateHooks();
  const canMuteUsers = useHasPermissions(OwnCapability.MUTE_USERS);
  const [isMuting, setIsMuting] = useState(false);

  if (!canMuteUsers || !call) return null;

  const muteEveryone = async () => {
    if (isMuting) return;
    setIsMuting(true);
    try {
      await call.muteAllUsers("audio");
      toast({
        title: "Everyone is muted",
        description: "Participants can unmute themselves when they speak.",
      });
    } catch {
      toast({
        title: "Could not mute everyone",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsMuting(false);
    }
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <button
          type="button"
          aria-label="Mute everyone"
          title="Mute everyone"
          data-testid="mute-all-button"
          disabled={isMuting}
          className="rounded-xl bg-zinc-800 p-3 transition-colors hover:bg-zinc-700 disabled:opacity-50"
        >
          <MicOff className="h-5 w-5 text-white" />
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Mute everyone?</AlertDialogTitle>
          <AlertDialogDescription>
            Every participant&apos;s microphone is turned off. They can turn it
            back on themselves.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid="mute-all-confirm"
            onClick={() => void muteEveryone()}
          >
            Mute everyone
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
