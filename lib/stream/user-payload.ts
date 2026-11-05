import type { UserResponse } from "stream-chat";
import { mapRoleToStream } from "@/lib/user";

/**
 * The only user fields Familiarise sends to Stream. Stream returns a user's
 * fields to every member of a shared channel, so contact data never goes there.
 */
export type StreamUserPayload = {
  id: string;
  name: string;
  image?: string;
  role: string;
};

type AppUserForStream = {
  id: string;
  name: string | null;
  image: string | null;
  role: string | null;
};

export function toStreamUser(user: AppUserForStream): StreamUserPayload {
  return {
    id: user.id,
    name: user.name ?? user.id,
    ...(user.image ? { image: user.image } : {}),
    role: mapRoleToStream(user.role),
  };
}

/** Contact fields an older upsert stored on Stream users; the sync job unsets them. */
export const STREAM_CONTACT_FIELDS = ["email"] as const satisfies ReadonlyArray<
  keyof UserResponse
>;

/** The contact fields present on one Stream user, for a `partialUpdateUsers` unset. */
export function staleContactFields(
  user: UserResponse,
): Array<(typeof STREAM_CONTACT_FIELDS)[number]> {
  return STREAM_CONTACT_FIELDS.filter(
    (field) => user[field] !== undefined && user[field] !== null,
  );
}
