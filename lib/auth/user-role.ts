import { UserRole } from "@prisma/client";

/**
 * The session's `user.role` is a database column, but BetterAuth's inferred
 * session type widens it to `string`. Narrow it ONCE, here, so every
 * consumer gets a real `UserRole` and no call site has to cast.
 *
 * A value outside the enum is a data-integrity fault, not a privilege: it
 * resolves to the LEAST privileged role, so a corrupt row can never widen an
 * account's access. `CONSULTEE` is the default for every new signup, which
 * makes it the right floor.
 */
const USER_ROLE_VALUES: readonly string[] = Object.values<string>(UserRole);

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && USER_ROLE_VALUES.includes(value);
}

/** The role as the session carries it, floored to the least privileged one. */
export function toUserRole(value: string | null | undefined): UserRole {
  return isUserRole(value) ? value : "CONSULTEE";
}
