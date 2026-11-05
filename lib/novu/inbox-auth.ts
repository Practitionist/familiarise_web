import { z } from "zod";

const SyncBodySchema = z.object({
  success: z.literal(true),
  subscriberHash: z.string().regex(/^[a-f0-9]{64}$/),
});

/**
 * Inbox sessions require a successful subscriber sync and its SHA-256 HMAC.
 * Never fall back to an unsigned session after a failed or malformed response.
 */
export function resolveInboxAuth(
  status: "pending" | "error" | "success",
  data: unknown,
):
  | { ready: false; subscriberHash?: undefined }
  | { ready: true; subscriberHash: string } {
  if (status !== "success") return { ready: false };
  const parsed = SyncBodySchema.safeParse(data);
  return parsed.success
    ? { ready: true, subscriberHash: parsed.data.subscriberHash }
    : { ready: false };
}
