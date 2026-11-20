import type { z } from "zod";

import type { SeatLiftBodySchema } from "@/schemas/seat-removal-lift";

/** The roster's "Allow back" request; its body is what `SeatLiftBodySchema` parses. */
export function allowBackRequest(
  apiSegment: "webinar" | "class",
  eventId: string,
  userId: string,
): { url: string; init: RequestInit } {
  const body: z.input<typeof SeatLiftBodySchema> = { userId };
  return {
    url: `/api/participants/${apiSegment}/${eventId}/allow-back`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  };
}
