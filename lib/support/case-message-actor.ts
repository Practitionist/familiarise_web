import { z } from "zod";

/** Persisted in `SupportCaseMessage.metadata`; no schema change needed. */
export const PRESENTER_MESSAGE_METADATA = { actorKind: "PRESENTER" };

const PresenterMessageMetadataSchema = z.object({
  actorKind: z.literal("PRESENTER"),
});

export function isPresenterAuthoredMessage(metadata: unknown): boolean {
  return PresenterMessageMetadataSchema.safeParse(metadata).success;
}
