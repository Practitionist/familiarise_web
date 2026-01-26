import { Prisma } from "@prisma/client";

/**
 * Represents a User with professional background relations.
 * This type uses Prisma's generated types to ensure type safety and consistency with the database schema.
 *
 * @typedef {Object} TUserWithProfessionalBackground
 * @property {Object[]} workExperiences - Work experience entries for the user.
 * @property {Object[]} education - Education entries for the user.
 * @property {Object[]} certifications - Certification entries for the user.
 */
export type TUserWithProfessionalBackground = Prisma.UserGetPayload<{
  include: {
    workExperiences: true;
    education: true;
    certifications: true;
  };
}>;
