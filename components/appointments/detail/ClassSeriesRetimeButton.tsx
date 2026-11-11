"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { CalendarClock } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ClassPatternScheduler } from "@/components/scheduling/ClassPatternScheduler";

const MovableSchema = z.object({
  count: z.number().int().nonnegative(),
  sessionMinutes: z.number().int().positive(),
  firstStartsAt: z.string().nullable(),
});

/**
 * "Move upcoming sessions" for a sold class's host: a new weekly pattern for
 * every session at least 24 hours away, moved in one step. Learners are told
 * and may leave with a full refund for a while; nobody's sessions are
 * cancelled, so no miss is recorded.
 */
export function ClassSeriesRetimeButton({
  appointmentId,
  classId,
  consultantProfileId,
  schedulingTimezone,
  sessionsPerWeek,
  onMoved,
}: Readonly<{
  appointmentId: string;
  classId: string;
  consultantProfileId: string;
  /** The class's own zone: its weekly pattern is wall-clock time there. */
  schedulingTimezone: string;
  sessionsPerWeek: number;
  onMoved: () => void;
}>) {
  const [open, setOpen] = useState(false);
  const movable = useQuery({
    queryKey: ["class-series-movable", appointmentId],
    enabled: open,
    staleTime: 0,
    queryFn: async () => {
      const response = await fetch(
        `/api/appointments/${appointmentId}/retime-series`,
      );
      if (!response.ok) throw new Error("Couldn't load the class sessions.");
      return MovableSchema.parse(await response.json());
    },
  });

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <CalendarClock className="mr-2 h-4 w-4" />
        Move upcoming sessions
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Move upcoming sessions</DialogTitle>
            <DialogDescription>
              Pick a new weekly pattern. Every session at least 24 hours away
              moves to it; anything sooner keeps its time. Learners are told,
              keep their seats, and anyone who can&apos;t make the new times can
              leave with a full refund.
            </DialogDescription>
          </DialogHeader>
          {movable.isPending && (
            <p className="text-sm text-muted-foreground">Loading sessions…</p>
          )}
          {movable.isError && (
            <p className="text-sm text-destructive">{movable.error.message}</p>
          )}
          {movable.data && movable.data.count === 0 && (
            <p className="text-sm text-muted-foreground">
              No session is at least 24 hours away. Cancel a session and
              schedule a make-up instead.
            </p>
          )}
          {movable.data && movable.data.count > 0 && (
            <ClassPatternScheduler
              mode="retime"
              appointmentId={appointmentId}
              classId={classId}
              consultantId={consultantProfileId}
              zone={schedulingTimezone}
              sessionMinutes={movable.data.sessionMinutes}
              totalSessions={movable.data.count}
              sessionsPerWeek={sessionsPerWeek}
              hasSessions
              onSaved={() => {
                setOpen(false);
                onMoved();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
