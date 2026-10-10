import "server-only";
import {
  mergeAdjacentCustomRows,
  mergeAdjacentWeeklyRows,
} from "@/utils/scheduling-engine/mergeAdjacentWeeklyRows";
import * as Sentry from "@sentry/nextjs";
import { Prisma } from "@prisma/client";
import { UserRole, ScheduleType } from "@prisma/client";
import prisma, { type Tx } from "@/lib/prisma";
import {
  resolveWeeklyTimezone,
  resolveWeeklyUtcOffsetMinutes,
  weeklyRowLocalColumns,
} from "@/lib/scheduling/weeklyUtcOffset";
import type { StagedTrigger } from "@/lib/novu";
import { attemptBellsAfterResponse } from "@/lib/verification/notify-admins";
import { submitVerificationRequest as submitVerificationRequestCore } from "@/lib/verification/submit-request";
import { recomputeProfileCompletion } from "@/lib/profiles/profile-completion";
import {
  assertCustomWindows,
  assertWeeklyWindows,
  AvailabilityContractError,
} from "@/lib/scheduling/availability-contract";
import type { OnboardingData, ConsultantProfileCreateData } from "./onboarding";
import type { VerificationDocumentRefSchema } from "./onboarding";
import type { z } from "zod";
import {
  canAddConsultantIdentity,
  OnboardingRefusedError,
  refusalFromIssues,
  refusalResult,
  buildUserUpdateData,
  buildConsultantScalarData,
  buildConsulteeScalarData,
  isFullyOnboarded,
  validateProfessionalBackground,
  shouldSubmitVerification,
  isPersistableVerificationDoc,
} from "./onboarding-shared";
import {
  claimOnboardingCompletion,
  recordOnboardingConsent,
} from "./onboarding-completion";

// A contract refusal names its window; the wizard needs the field too.
function toRefusal(error: unknown, field: "weeklySlots" | "customSlots") {
  if (error instanceof AvailabilityContractError) {
    return new OnboardingRefusedError(
      error.code,
      error.message,
      field,
      error.index,
    );
  }
  return error;
}

// ============================================================================
// TYPES
// ============================================================================

/**
 * Shape of a verification document as received from the onboarding form.
 *
 * Derived from the schema rather than hand-written, so it cannot drift from what
 * the write boundary actually accepts (#1869). `id` is required by the schema,
 * which is why the cast to `VerificationDocumentInput[]` at the link site is no
 * longer needed to narrow away `undefined`.
 */
type VerificationDocumentInput = z.infer<typeof VerificationDocumentRefSchema>;

/** Verification-related fields extracted from the onboarding body */
interface VerificationBody {
  verificationLinkedinUrl?: string;
  verificationNotes?: string;
  verificationDocuments?: VerificationDocumentInput[];
}

// ============================================================================
// HELPERS
// ============================================================================

async function assertUserExists(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!user)
    throw new OnboardingRefusedError("USER_NOT_FOUND", "User not found");
}

/** A P2002 on `User.phone`, routed to the phone field. */
function phoneTakenRefusal(error: unknown): OnboardingRefusedError | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== "P2002"
  ) {
    return null;
  }
  const target = error.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : [String(target)];
  if (!fields.some((f) => f.includes("phone"))) return null;
  return new OnboardingRefusedError(
    "PHONE_TAKEN",
    "This phone number is already linked to another account.",
    "phone",
  );
}

// ============================================================================
// PROFILE UPSERT FUNCTIONS
// ============================================================================

async function upsertConsultantProfile(
  userId: string,
  profileData: ConsultantProfileCreateData,
  tx: Tx,
  timezone?: string,
) {
  const scalarData = buildConsultantScalarData(profileData);
  const domainId = profileData.domain.connect.id;

  // Validate domain/subdomain/tag consistency
  const tagIds = profileData.tags?.connect?.map((t) => t.id) ?? [];
  const subDomainIds =
    profileData.subDomains?.connect?.map((sd) => sd.id) ?? [];

  if (tagIds.length > 0) {
    const validTags = await tx.tag.count({
      where: { id: { in: tagIds }, domainId },
    });
    if (validTags !== tagIds.length) {
      throw new OnboardingRefusedError(
        "INVALID_SELECTION",
        "One or more selected skills do not belong to the chosen field of expertise",
        "tags",
      );
    }
  }

  if (subDomainIds.length > 0) {
    const validSubDomains = await tx.subDomain.count({
      where: { id: { in: subDomainIds }, domainId },
    });
    if (validSubDomains !== subDomainIds.length) {
      throw new OnboardingRefusedError(
        "INVALID_SELECTION",
        "One or more selected specialties do not belong to the chosen field of expertise",
        "subDomains",
      );
    }
  }

  const consultantProfile = await tx.consultantProfile.upsert({
    where: { userId },
    create: {
      userId,
      domainId,
      subDomains: profileData.subDomains?.connect
        ? { connect: profileData.subDomains.connect }
        : undefined,
      tags: profileData.tags?.connect
        ? { connect: profileData.tags.connect }
        : undefined,
      ...scalarData,
    },
    update: {
      domain: { connect: { id: domainId } },
      subDomains: profileData.subDomains?.connect
        ? { set: profileData.subDomains.connect }
        : { set: [] },
      tags: profileData.tags?.connect
        ? { set: profileData.tags.connect }
        : { set: [] },
      ...scalarData,
    },
  });

  await syncAvailabilitySlots(
    consultantProfile.id,
    scalarData.scheduleType,
    profileData,
    tx,
    timezone,
  );

  return { consultantProfileId: consultantProfile.id };
}

async function syncAvailabilitySlots(
  consultantProfileId: string,
  scheduleType: ScheduleType,
  profileData: ConsultantProfileCreateData,
  tx: Tx,
  timezone?: string,
) {
  // #1326 — this path stored 0 for a consultant with no onboarding timezone,
  // so their whole published week projected as if they lived in UTC. One
  // resolver now answers for every write path, and a conflicting caller value
  // throws into the failed transaction rather than being written.
  const utcOffsetMinutes = resolveWeeklyUtcOffsetMinutes({
    profileTimezone: timezone,
    consultantProfileId,
  });
  const rowTimezone = resolveWeeklyTimezone(timezone);
  if (scheduleType === ScheduleType.WEEKLY) {
    await tx.availabilityWindowCustom.deleteMany({
      where: { consultantProfileId },
    });
    await tx.availabilityWindowWeekly.deleteMany({
      where: { consultantProfileId },
    });

    // The contract refuses an empty set: a CONSULTANT with scheduleType WEEKLY
    // and no windows is unbookable and no guard would ever notice (the wizard
    // enforced "at least one" client-side only).
    const weeklySlotsToCreate =
      profileData.availabilityWindowsWeekly?.create ?? [];
    try {
      assertWeeklyWindows(weeklySlotsToCreate);
    } catch (error) {
      throw toRefusal(error, "weeklySlots");
    }
    // #1320 — adjacent entries ("3:30–4:30" + "4:30–5:30") become one row so
    // storage matches the window the customer is shown and can book.
    //
    // #1326 — the offset is stamped BEFORE the merge: mergeAdjacentWeeklyRows
    // refuses to fold rows whose offsets differ, and every row here carried
    // an absent offset until after the fold, so that guard was comparing
    // undefined with undefined and could never fire.
    // #872 — the five DST columns are derived from the MERGED row, which is
    // the one actually stored. No reader consults them until the reader flip.
    const rowsWithOffset = weeklySlotsToCreate.map((slot) => ({
      ...slot,
      utcOffsetMinutes,
    }));
    await tx.availabilityWindowWeekly.createMany({
      data: mergeAdjacentWeeklyRows(rowsWithOffset).map((slot) => ({
        startDay: slot.startDay,
        startTimeUtc: slot.startTimeUtc,
        endDay: slot.endDay,
        endTimeUtc: slot.endTimeUtc,
        consultantProfileId,
        utcOffsetMinutes,
        ...weeklyRowLocalColumns(slot, rowTimezone, utcOffsetMinutes),
      })),
    });
  } else if (scheduleType === ScheduleType.CUSTOM) {
    await tx.availabilityWindowWeekly.deleteMany({
      where: { consultantProfileId },
    });
    await tx.availabilityWindowCustom.deleteMany({
      where: { consultantProfileId },
    });

    const customSlotsToCreate =
      profileData.availabilityWindowsCustom?.create ?? [];
    try {
      assertCustomWindows(customSlotsToCreate);
    } catch (error) {
      throw toRefusal(error, "customSlots");
    }
    // #1320 — merge AFTER the per-slot 12-hour cap above, so a chain of
    // adjacent entries still has each entry checked on its own.
    await tx.availabilityWindowCustom.createMany({
      data: mergeAdjacentCustomRows(
        customSlotsToCreate.map((slot) => ({
          startsAt: new Date(slot.startsAt),
          endsAt: new Date(slot.endsAt),
          consultantProfileId,
        })),
      ),
    });
  }
}

async function upsertConsulteeProfile(
  userId: string,
  profileData: Parameters<typeof buildConsulteeScalarData>[0],
  tx: Tx,
) {
  const scalarData = buildConsulteeScalarData(profileData);
  const profile = await tx.consulteeProfile.upsert({
    where: { userId },
    create: { userId, ...scalarData },
    update: scalarData,
  });
  return { consulteeProfileId: profile.id };
}

/**
 * Add a consultant identity to an onboarded CONSULTEE / ORG_WORKSPACE account.
 * Same validation, profile upsert, availability contract, professional
 * background and verification path as first-time onboarding — but the user
 * row is touched only to link the profile (and to flip a CONSULTEE to
 * CONSULTANT; an ORG_WORKSPACE keeps its role and reaches the consultant
 * dashboard through the switcher). Other profile links are never nulled.
 */
export async function addConsultantIdentity(
  userId: string,
  body: unknown,
): Promise<OnboardingResult> {
  const { validateOnboardingData } = await import("./onboarding");
  try {
    const validationResult = validateOnboardingData(body);
    if (!validationResult.success) {
      return refusalResult(
        refusalFromIssues(validationResult.issues, validationResult.error),
        validationResult.error,
      );
    }
    const validatedBody = validationResult.data;
    if (validatedBody.role !== UserRole.CONSULTANT) {
      return {
        success: false,
        error:
          "Only a consultant identity can be added to an existing account.",
      };
    }

    const current = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        role: true,
        onboardingCompleted: true,
        consultantProfileId: true,
        timezone: true,
      },
    });
    if (!current) {
      throw new OnboardingRefusedError("USER_NOT_FOUND", "User not found");
    }
    if (!canAddConsultantIdentity(current)) {
      return {
        success: false,
        error:
          "Your account cannot add an expert profile: finish onboarding first, or you already have one.",
      };
    }

    const updatedUser = await prisma.$transaction(
      async (tx) => {
        const profileFkData = await upsertProfileByRole(
          userId,
          validatedBody,
          tx,
        );
        await persistProfessionalBackground(
          userId,
          profileFkData.consultantProfileId,
          body as Record<string, unknown>,
          tx,
        );
        if (profileFkData.consultantProfileId) {
          await recomputeProfileCompletion(
            tx,
            profileFkData.consultantProfileId,
          );
        }
        await recordOnboardingConsent(tx, userId, validatedBody);
        // CAS on the empty link: two tabs adding at once cannot both win.
        const linked = await tx.user.updateMany({
          where: { id: userId, consultantProfileId: null },
          data: {
            consultantProfileId: profileFkData.consultantProfileId,
            ...(current.role === UserRole.CONSULTEE
              ? { role: UserRole.CONSULTANT }
              : {}),
            ...(current.timezone ? {} : { timezone: validatedBody.timezone }),
            ...(validatedBody.linkedinUrl
              ? { linkedinUrl: validatedBody.linkedinUrl }
              : {}),
          },
        });
        if (linked.count === 0) {
          throw new OnboardingRefusedError(
            "IDENTITY_ALREADY_ADDED",
            "An expert profile was just added to this account elsewhere. Reload to continue.",
          );
        }
        return tx.user.findUniqueOrThrow({
          where: { id: userId },
          include: onboardingUserInclude,
        });
      },
      { maxWait: 15000, timeout: 45000 },
    );

    const verification = await maybeSubmitConsultantVerification(
      userId,
      updatedUser,
      body,
      UserRole.CONSULTANT,
    );
    return {
      success: true,
      user: updatedUser,
      verificationWarning: verification?.warning,
      verificationDeferred: verification?.deferred,
    };
  } catch (error: unknown) {
    reportUnexpected(error, "add-identity");
    return refusalResult(
      phoneTakenRefusal(error) ?? error,
      "An unknown error occurred while adding the expert profile.",
    );
  }
}

async function upsertProfileByRole(
  userId: string,
  validatedBody: OnboardingData,
  tx: Tx,
): Promise<{
  consultantProfileId?: string;
  consulteeProfileId?: string;
}> {
  switch (validatedBody.role) {
    case UserRole.CONSULTANT:
      return upsertConsultantProfile(
        userId,
        validatedBody.consultantProfile.create,
        tx,
        validatedBody.timezone,
      );
    case UserRole.CONSULTEE:
      return upsertConsulteeProfile(
        userId,
        validatedBody.consulteeProfile.create,
        tx,
      );
    default: {
      const _exhaustiveCheck: never = validatedBody;
      throw new Error(
        `Invalid role: ${String((_exhaustiveCheck as { role: string }).role)}`,
      );
    }
  }
}

// ============================================================================
// PROFESSIONAL BACKGROUND PERSISTENCE (validated via Zod)
// ============================================================================

export async function persistProfessionalBackground(
  userId: string,
  consultantProfileId: string | undefined,
  body: Record<string, unknown>,
  tx: Tx,
) {
  const {
    workExperiences,
    educationHistory,
    certificationsList,
    achievements,
  } = validateProfessionalBackground(body);

  // For each section: null means "field absent from payload" (skip),
  // empty array means "user cleared all entries" (delete old rows).
  if (workExperiences !== null) {
    await tx.workExperience.deleteMany({ where: { userId } });
    if (workExperiences.length > 0) {
      await tx.workExperience.createMany({
        data: workExperiences.map((we) => ({
          userId,
          company: we.company,
          companyDomain: we.companyDomain || null,
          title: we.title,
          location: we.location || null,
          startDate: new Date(we.startDate),
          endDate: we.endDate ? new Date(we.endDate) : null,
          isCurrent: we.isCurrent ?? false,
          description: we.description || null,
        })),
      });
    }
  }

  if (educationHistory !== null) {
    await tx.education.deleteMany({ where: { userId } });
    if (educationHistory.length > 0) {
      await tx.education.createMany({
        data: educationHistory.map((edu) => ({
          userId,
          institution: edu.institution,
          institutionDomain: edu.institutionDomain || null,
          degree: edu.degree,
          fieldOfStudy: edu.fieldOfStudy || null,
          startYear: edu.startYear || null,
          endYear: edu.endYear || null,
          grade: edu.grade || null,
          activities: edu.activities || null,
          description: edu.description || null,
        })),
      });
    }
  }

  if (certificationsList !== null) {
    await tx.certification.deleteMany({ where: { userId } });
    if (certificationsList.length > 0) {
      await tx.certification.createMany({
        data: certificationsList.map((cert) => ({
          userId,
          name: cert.name,
          issuingOrganization: cert.issuingOrganization,
          issueDate: new Date(cert.issueDate),
          expiryDate: cert.expiryDate ? new Date(cert.expiryDate) : null,
          credentialId: cert.credentialId || null,
          credentialUrl: cert.credentialUrl || null,
        })),
      });
    }
  }

  if (consultantProfileId && achievements !== null) {
    await tx.achievement.deleteMany({
      where: { consultantProfileId },
    });
    if (achievements.length > 0) {
      await tx.achievement.createMany({
        data: achievements.map((ach) => ({
          consultantProfileId,
          title: ach.title,
          description: ach.description || null,
          url: ach.url || null,
          imageUrl: ach.imageUrl || null,
          achievementType: ach.achievementType || "OTHER",
        })),
      });
    }
  }
}

// ============================================================================
// VERIFICATION HANDLING
// ============================================================================

/**
 * Onboarding-completion adapter over the one submission writer
 * (`lib/verification/submit-request.ts`). Uploads made from the wizard are
 * rows already (unlinked, owned by this user), so the core links them by id
 * with the ownership predicate — the arbitrary-id linking #1224 described is
 * gone. An id-less entry from an older draft is not persistable: the wizard
 * defers verification and the consultant re-uploads from Settings.
 */
async function submitVerificationRequest(
  userId: string,
  consultantProfileId: string,
  body: VerificationBody,
): Promise<{ staged: StagedTrigger[] }> {
  const { verificationLinkedinUrl, verificationNotes, verificationDocuments } =
    body;

  if (!verificationLinkedinUrl?.trim()) {
    throw new Error("LinkedIn URL is required for consultant verification");
  }
  if (!verificationDocuments || verificationDocuments.length === 0) {
    throw new Error("At least one verification document is required");
  }

  // Every upload has a row since rows-at-upload, so only ids are linked; an
  // id-less entry from an older draft is not persistable and defers instead.
  // `id` is required by the schema, so the filter only has to drop drafts.
  const documentIds = verificationDocuments
    .filter(isPersistableVerificationDoc)
    .map((doc) => doc.id);

  const outcome = await submitVerificationRequestCore({
    userId,
    consultantProfileId,
    notes: verificationNotes || null,
    linkedinUrl: verificationLinkedinUrl,
    documentIds,
    carryOver: false,
  });
  if (!outcome.ok) {
    throw new OnboardingRefusedError(
      outcome.code,
      outcome.message,
      "verificationDocuments",
    );
  }
  // The admin bells were staged inside the submission transaction; the
  // caller attempts them after the response.
  return { staged: outcome.staged };
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

const onboardingUserInclude = {
  consultantProfile: {
    include: {
      availabilityWindowsWeekly: true,
      availabilityWindowsCustom: true,
      domain: true,
      subDomains: true,
      tags: true,
    },
  },
  consulteeProfile: true,
  workExperiences: true,
  education: true,
  certifications: true,
} satisfies Prisma.UserInclude;

type OnboardingUser = Prisma.UserGetPayload<{
  include: typeof onboardingUserInclude;
}>;

type OnboardingResult = {
  success: boolean;
  /** Machine word for a typed refusal (contract or verification core). */
  code?: string;
  /** The payload field the refusal is about; the wizard opens its step. */
  field?: string;
  index?: number;
  // `user` is a Prisma User with deeply-included relations (consultantProfile,
  // consulteeProfile, slots, domain, etc.). Typing it precisely would require a
  // shared Prisma payload type across server/action/client layers — not worth
  // the coupling. Callers only read a few string IDs from it.
  user?: Record<string, unknown>;
  error?: string;
  verificationWarning?: string;
  /// True when the consultant finished onboarding without completing the
  /// verification package (LinkedIn + ≥1 document). The profile exists with
  /// verificationStatus PENDING_VERIFICATION; the client uses this to show a
  /// "finish from Settings" message instead of "under review".
  verificationDeferred?: boolean;
};

/** Lost the claim: another request completed onboarding first. */
class OnboardingClaimLostError extends Error {
  constructor() {
    super("onboarding already completed");
    this.name = "OnboardingClaimLostError";
  }
}

async function runOnboardingTransaction(
  userId: string,
  validatedBody: OnboardingData,
  body: unknown,
): Promise<OnboardingUser> {
  return prisma.$transaction(
    async (tx) => {
      // Claim first: holds the user-row lock, so a racing submit waits here
      // and then sees count 0 instead of rewriting profile rows.
      const claimed = await claimOnboardingCompletion(
        tx,
        userId,
        buildUserUpdateData(validatedBody),
      );
      if (!claimed) throw new OnboardingClaimLostError();

      const profileFkData = await upsertProfileByRole(
        userId,
        validatedBody,
        tx,
      );

      await persistProfessionalBackground(
        userId,
        profileFkData.consultantProfileId,
        body as Record<string, unknown>,
        tx,
      );

      if (profileFkData.consultantProfileId) {
        await recomputeProfileCompletion(tx, profileFkData.consultantProfileId);
      }

      await recordOnboardingConsent(tx, userId, validatedBody);

      return tx.user.update({
        where: { id: userId },
        data: profileFkData,
        include: onboardingUserInclude,
      });
    },
    { maxWait: 15000, timeout: 45000 },
  );
}

/**
 * Another request completed onboarding for this user. Success only when it
 * chose the same role and is fully onboarded; otherwise a typed refusal so
 * this device's answers are not silently dropped. Null means rethrow.
 */
async function recoverIdempotentOnboarding(
  userId: string,
  submittedRole: OnboardingData["role"],
  error: unknown,
): Promise<OnboardingResult | null> {
  const lostRace =
    error instanceof OnboardingClaimLostError ||
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      phoneTakenRefusal(error) === null);
  if (!lostRace) return null;
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    include: onboardingUserInclude,
  });
  if (!existing?.onboardingCompleted) return null;
  if (existing.role === submittedRole && isFullyOnboarded(existing)) {
    return { success: true, user: existing };
  }
  return {
    success: false,
    code: "ALREADY_ONBOARDED",
    error:
      "Your account finished setup on another device. Reload to continue from there.",
  };
}

/** One Sentry event per failed request, only for non-refusal failures. */
function reportUnexpected(error: unknown, op: string) {
  if (error instanceof OnboardingRefusedError || phoneTakenRefusal(error)) {
    return;
  }
  Sentry.captureException(
    new Error(
      `onboarding_${op}_failed: ${error instanceof Error ? error.name : "unknown"}`,
    ),
    { tags: { subsystem: "onboarding", op } },
  );
}

/**
 * Post-transaction consultant verification. Returns a warning string when the
 * profile saved but the verification submission failed; `deferred: true` when
 * the consultant finished without a complete verification package. The policy
 * itself lives in `shouldSubmitVerification` (onboarding-shared) so it stays
 * unit-testable outside this server-only module.
 */
async function maybeSubmitConsultantVerification(
  userId: string,
  updatedUser: OnboardingUser,
  body: unknown,
  role: OnboardingData["role"],
): Promise<{ warning?: string; deferred?: boolean } | undefined> {
  if (role !== UserRole.CONSULTANT || !updatedUser.consultantProfileId) {
    return undefined;
  }

  const verificationBody = body as VerificationBody;
  const { hasDocuments, hasLinkedin } =
    shouldSubmitVerification(verificationBody);

  // Deferred path (#onboarding-ux): the profile is real and saved with the
  // model default PENDING_VERIFICATION ("onboarding complete, awaiting
  // review"); marketplace visibility continues to gate on verification, so a
  // deferred consultant is simply unlisted until they finish from Settings.
  // Whatever LinkedIn they did enter still lands on the User row.
  if (!hasDocuments || !hasLinkedin) {
    if (hasLinkedin) {
      await prisma.user.update({
        where: { id: userId },
        data: {
          linkedinUrl: verificationBody.verificationLinkedinUrl!.trim(),
        },
      });
    }
    return { deferred: true };
  }

  try {
    const { staged } = await submitVerificationRequest(
      userId,
      updatedUser.consultantProfileId,
      verificationBody,
    );
    attemptBellsAfterResponse(staged);
    return undefined;
  } catch (verificationError) {
    // #698 OB-3 — never silent: the profile is committed and stays
    // PENDING_VERIFICATION, so the consultant can finish from Settings; the
    // failure itself is paged so ops sees the rate, not just the user.
    Sentry.captureException(
      verificationError instanceof Error
        ? verificationError
        : new Error(String(verificationError)),
      {
        tags: { subsystem: "onboarding", op: "verification-submit" },
        extra: { userId, consultantProfileId: updatedUser.consultantProfileId },
      },
    );
    return {
      deferred: true,
      warning:
        "Your profile was saved, but the verification request could not be filed. You can submit it from Settings → Verification.",
    };
  }
}

export async function processOnboardingData(
  userId: string,
  body: unknown,
): Promise<OnboardingResult> {
  const { validateOnboardingData } = await import("./onboarding");

  try {
    const validationResult = validateOnboardingData(body);
    if (!validationResult.success) {
      return refusalResult(
        refusalFromIssues(validationResult.issues, validationResult.error),
        validationResult.error,
      );
    }

    const validatedBody = validationResult.data;
    await assertUserExists(userId);

    let updatedUser: OnboardingUser;
    try {
      updatedUser = await runOnboardingTransaction(userId, validatedBody, body);
    } catch (error: unknown) {
      const recovered = await recoverIdempotentOnboarding(
        userId,
        validatedBody.role,
        error,
      );
      if (recovered) return recovered;
      throw error;
    }

    const verification = await maybeSubmitConsultantVerification(
      userId,
      updatedUser,
      body,
      validatedBody.role,
    );

    return {
      success: true,
      user: updatedUser,
      verificationWarning: verification?.warning,
      verificationDeferred: verification?.deferred,
    };
  } catch (error: unknown) {
    reportUnexpected(error, "submit");
    return refusalResult(
      phoneTakenRefusal(error) ?? error,
      "An unknown error occurred while updating onboarding information.",
    );
  }
}
