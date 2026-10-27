import { z } from "zod";

const SyncBodySchema = z.object({ subscriberHash: z.string().min(1) });

/**
 * The Inbox must not connect until the subscriber sync has settled: a first
 * connection without `subscriberHash` is rejected when the Novu environment
 * enforces HMAC. A failed sync still lets it mount (hash-less) so a fault in
 * the sync route cannot hide the bell.
 */
export function resolveInboxAuth(
  status: "pending" | "error" | "success",
  data: unknown,
): { ready: boolean; subscriberHash?: string } {
  if (status === "pending") return { ready: false };
  const parsed = SyncBodySchema.safeParse(data);
  return {
    ready: true,
    ...(parsed.success ? { subscriberHash: parsed.data.subscriberHash } : {}),
  };
}
