import { NextResponse } from "next/server";
import { z } from "zod";
import { EventEditorStatusSchema } from "@/schemas/event-instance";

export type EventEditorStatus = z.infer<typeof EventEditorStatusSchema>;

/** The editor's status intent, or a 409 for any status only the cancel route or server code may write. */
export function editorStatusOrRefusal(
  raw: unknown,
  noun: "webinar" | "class",
): EventEditorStatus | undefined | NextResponse {
  const parsed = EventEditorStatusSchema.optional().safeParse(raw);
  if (parsed.success) return parsed.data;
  return NextResponse.json(
    {
      error: `Cancel a ${noun} through its cancel action, not an update.`,
      code: "USE_CANCEL_ROUTE",
    },
    { status: 409 },
  );
}
