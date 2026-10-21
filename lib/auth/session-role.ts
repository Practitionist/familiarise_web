import { UserRole } from "@prisma/client";
import { z } from "zod";

const userRoleSchema = z.nativeEnum(UserRole);

/**
 * The signed-in user's role as the Prisma enum.
 *
 * The session carries the role as a string, so it is parsed rather than cast:
 * a session whose role is not one the schema defines yields null, and every
 * permission check downstream treats null as "not permitted". A cast would
 * instead let an unrecognised role through as a valid enum member.
 */
export function sessionRole(role: string | null | undefined): UserRole | null {
  const parsed = userRoleSchema.safeParse(role);
  return parsed.success ? parsed.data : null;
}
