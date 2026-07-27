import { createHash } from "node:crypto";

/**
 * Stream caps channel ids at 64 characters. Nothing used to check that, and we
 * are closer to the ceiling than anyone realised: a seeded cuid pair already
 * produces 54 characters and the longest live channel measured 61. Two users on
 * 36-character uuid ids — 17 accounts carry them — would produce 76 and be
 * rejected by Stream at runtime, silently, because the create action's
 * `channelIdSchema` only asserts `min(1)`.
 */
export const STREAM_CHANNEL_ID_MAX = 64;

/** Short, stable digest. Hex, so the result is always `[a-f0-9]` — Stream-safe. */
function digest(value: string, chars: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, chars);
}

function assertFits(channelId: string): string {
  if (channelId.length > STREAM_CHANNEL_ID_MAX) {
    throw new Error(
      `Stream channel id exceeds ${STREAM_CHANNEL_ID_MAX} chars (${channelId.length}): ${channelId}`,
    );
  }
  return channelId;
}

/**
 * Deterministic Stream channel id for a consultant–consultee DM.
 *
 * A DM used to be keyed on the pair alone, which made the channel the
 * RELATIONSHIP rather than the booking: the same two people had one thread no
 * matter how many sessions they booked or who funded them, and it carried the
 * org tag of whichever booking happened to create it. ADR 19 splits dashboards
 * by org-ness, so that single thread could not land in the right place — a pair
 * who work both B2C and through an org had one conversation belonging in two
 * dashboards. The org is now part of the key, so a pair gets one thread per
 * context.
 *
 * The two forms are deliberately different shapes rather than one scheme with an
 * appended segment:
 *
 *   personal   `dm-<a>-<b>`              54–61 chars, byte-identical to before
 *   org        `dmo-<org8>-<pair16>`     29 chars
 *
 * Personal ids are unchanged, so every existing conversation keeps its channel —
 * and there was no headroom to extend them in any case (61 of 64). The org form
 * hashes both halves precisely because appending anything to the pair would have
 * overflowed. Verified before shipping that zero org-tagged channels existed, so
 * nothing needed migrating.
 *
 * Opaque ids are the cost. Debugging goes through the channel's members and its
 * `organization_id` custom field, both set at creation.
 */
export function getDmChannelId(
  userId1: string,
  userId2: string,
  organizationId?: string | null,
): string {
  const [a, b] = [userId1, userId2].sort((x, y) => x.localeCompare(y));

  if (!organizationId) {
    return assertFits(`dm-${a}-${b}`);
  }

  // Hash the pair, not only the org: the pair is the long part, and the point is
  // to stay well inside the ceiling rather than creep back up to it.
  return assertFits(
    `dmo-${digest(organizationId, 8)}-${digest(`${a}-${b}`, 16)}`,
  );
}
