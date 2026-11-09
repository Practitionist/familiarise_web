"use client";

import { useState } from "react";
import { useCall, useCallStateHooks } from "@stream-io/video-react-sdk";
import { UserMinus } from "lucide-react";
import { z } from "zod";

import {
  RemoveParticipantDialog,
  type RemovalChoice,
} from "@/components/events/RemoveParticipantDialog";
import { useToast } from "@/hooks/use-toast";

const removalResult = z.object({
  removed: z.boolean(),
  caseReference: z.string().optional(),
  earningsHeld: z.boolean().optional(),
});
const refusalBody = z.object({ error: z.string().min(1) });

const useNoParticipants = () => [];
const useNoUser = () => undefined;

interface AttendeeModerationProps {
  eventTitle: string;
}

/**
 * Host and co-host control in the People tab of a webinar or class room: remove
 * an attendee for conduct. The server releases the seat, opens the support
 * review and kicks the attendee from the call and chat, so the removal is
 * recorded and the money is not left with the host unreviewed.
 */
export function AttendeeModeration({
  eventTitle,
}: Readonly<AttendeeModerationProps>) {
  const call = useCall();
  const { toast } = useToast();
  const hooks = useCallStateHooks();
  const useParticipants = hooks.useParticipants ?? useNoParticipants;
  const useLocalParticipant = hooks.useLocalParticipant ?? useNoUser;
  const useCallCreatedBy = hooks.useCallCreatedBy ?? useNoUser;
  const participants = useParticipants();
  const local = useLocalParticipant();
  const creator = useCallCreatedBy();
  const [target, setTarget] = useState<{ id: string; name: string } | null>(
    null,
  );

  // The server decides who is a removable attendee; this only hides the people
  // the room already knows are on the stage.
  const attendees = participants.filter(
    (p) =>
      p.userId !== local?.userId &&
      p.userId !== creator?.id &&
      !p.roles?.includes("co_presenter"),
  );
  if (!call || attendees.length === 0) return null;

  const remove = async (choice: RemovalChoice) => {
    if (!target || choice.mode !== "CONDUCT") return;
    const response = await fetch(
      `/api/meetings/${encodeURIComponent(call.id)}/remove`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetUserId: target.id,
          reason: choice.reason,
          note: choice.note,
        }),
      },
    );
    if (!response.ok) {
      const body = refusalBody.safeParse(
        await response.json().catch(() => null),
      );
      throw new Error(
        body.success ? body.data.error : "We couldn't remove them. Try again.",
      );
    }
    const result = removalResult.parse(await response.json());
    if (!result.removed) {
      throw new Error(
        "They aren't an attendee of this session, so nothing changed.",
      );
    }
    toast({
      title: `${target.name} was removed`,
      description: `Support case ${result.caseReference ?? ""} reviews it${
        result.earningsHeld
          ? "; your earnings from their seat are held until it is decided"
          : ""
      }.`,
    });
  };

  return (
    <section
      aria-label="Manage attendees"
      className="border-b border-zinc-800 p-3"
    >
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        Attendees
      </h3>
      <ul className="max-h-48 space-y-1 overflow-y-auto">
        {attendees.map((p) => {
          const name = p.name || "Attendee";
          return (
            <li
              key={p.userId}
              className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-800"
            >
              <span className="truncate text-sm text-zinc-200">{name}</span>
              <button
                type="button"
                aria-label={`Remove ${name}`}
                title={`Remove ${name}`}
                data-testid={`remove-attendee-${p.userId}`}
                onClick={() => setTarget({ id: p.userId, name })}
                className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-red-400"
              >
                <UserMinus className="h-4 w-4" />
              </button>
            </li>
          );
        })}
      </ul>
      <RemoveParticipantDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        attendeeName={target?.name ?? null}
        eventTitle={eventTitle}
        allowNoFault={false}
        onSubmit={remove}
      />
    </section>
  );
}
