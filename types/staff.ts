import { Prisma } from "@prisma/client";

/**
 * Represents a StaffProfile with specific included relations.
 * This type uses Prisma's generated types to ensure type safety and consistency with the database schema.
 *
 * @typedef {Object} TStaffProfile
 * @property {Object} user - The user associated with this staff profile.
 * @property {string} department - The department the staff member belongs to.
 * @property {string} position - The position of the staff member.
 * @property {Object} permissions - The permissions assigned to the staff member.
 * @property {Object} responsibilities - The responsibilities of the staff member.
 */
export type TStaffProfile = Prisma.StaffProfileGetPayload<{
  include: {
    user: true;
  };
}>;

// By using Prisma.StaffProfileGetPayload, we ensure that the type
// exactly matches what Prisma will return when querying a StaffProfile
// with these specific relations included. This helps prevent type mismatches
// and provides better autocomplete and type checking in our application.
