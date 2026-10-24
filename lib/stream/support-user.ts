/**
 * The dedicated Stream user that represents Familiarise Support in a booking
 * chat. It never logs in and no token is ever minted for it; staff post as it
 * through an audited server route. Safe to import from client components.
 */
export const SUPPORT_STREAM_USER_ID = "familiarise-support";
export const SUPPORT_STREAM_USER_NAME = "Familiarise Support";

export function isSupportStreamUser(userId: string | null | undefined) {
  return userId === SUPPORT_STREAM_USER_ID;
}
