import { dropUnchangedPastWindows } from "@/lib/scheduling/past-windows";
import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import {
  mergeAdjacentCustomRows,
  mergeAdjacentWeeklyRows,
} from "@/utils/scheduling-engine/mergeAdjacentWeeklyRows";
import {
  consultantPublicScalars,
  consultantPublicApiSchema,
  publicProfileUserSelect,
} from "@/lib/data/consultant-public";
import {
  BookingMode,
  DayOfWeek,
  type OrgPlanVisibility,
  Prisma,
  ScheduleType,
  OfferingFormat,
} from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { experienceValidation } from "@/schemas/shared";
import { maxActivePlanClientsSchema } from "@/schemas/plan-clients";
import { checkActiveAppointments } from "../utils/consultant-appointments";
import { getSession } from "@/lib/auth-server";
import { purgeExpertSurfaces } from "@/lib/data/public-cache";
import {
  afterCollaborationEnded,
  endCollaborationsForUser,
} from "@/lib/collaborators/ending";
import { apiError } from "@/lib/errors";
import { oneOnOnePlanDiscoverableWhere } from "@/lib/api/plans/visibility";
import { dateToMinuteUtc } from "@/utils/scheduling-engine/slotTimeUtils";
import {
  AVAILABILITY_REFUSAL_STATUS,
  validateCustomWindows,
  validateWeeklyWindows,
  weeklyZoneRefusal,
} from "@/lib/scheduling/availability-contract";
import {
  NONE_UNCOVERED,
  previewNewlyUncovered,
  settleAvailabilityWrite,
  type UncoveredUpcoming,
} from "@/lib/scheduling/uncovered-upcoming";
import type { ActiveAppointmentsResult } from "../utils/consultant-appointments";
import {
  resolveWeeklyTimezone,
  resolveWeeklyUtcOffsetMinutes,
  WeeklyOffsetConflictError,
  weeklyLocalColumnsForSave,
} from "@/lib/scheduling/weeklyUtcOffset";
import {
  isKnownTimeZone,
  partitionWeeklyRows,
} from "@/utils/schedule/weekly-projection";
import { readJsonBody } from "@/lib/api/parse";
// Zod schema for UUID validation
const uuidSchema = z.string().uuid();

// Zod schema for date-time string validation
const dateTimeSchema = z.string().datetime({ offset: true });

// Zod schema for weekly slot
const weeklySlotSchema = z.object({
  dayOfWeekforStartTimeInUTC: z.enum([
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ]),
  dayOfWeekforEndTimeInUTC: z.enum([
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ]),
  startsAt: dateTimeSchema,
  endsAt: dateTimeSchema,
});

// Zod schema for custom slot
const customSlotSchema = z.object({
  startsAt: dateTimeSchema,
  endsAt: dateTimeSchema,
});

// The Booking requests settings; null clears the cap. Only the PATCH writes
// them, so a whole-profile save can never carry a stale copy back.
const bookingRequestFields = z
  .object({
    bookingMode: z.nativeEnum(BookingMode).optional(),
    acceptingRequests: z.boolean().optional(),
    maxOpenRequests: z.number().int().min(1).max(50).nullable().optional(),
    maxActivePlanClients: maxActivePlanClientsSchema.optional(),
  })
  .strict();

// Main request body schema
const updateConsultantSchema = z
  .object({
    description: z.string().optional(),
    experience: experienceValidation,
    scheduleType: z.enum(["WEEKLY", "CUSTOM"]),
    domainId: uuidSchema,
    subDomainIds: z.array(uuidSchema),
    tagIds: z.array(uuidSchema),
    availabilityWindowsWeekly: z.array(weeklySlotSchema).optional(),
    availabilityWindowsCustom: z.array(customSlotSchema).optional(),
    // #1326 — accepted only so a caller who sends an offset is checked against
    // the profile timezone instead of silently ignored; it never wins.
    utcOffsetMinutes: z.number().int().min(-840).max(840).optional(),
    // The zone the weekly slots were typed in; defaults to the profile zone.
    weeklyTimezone: z
      .string()
      .max(64)
      .refine(isKnownTimeZone, "Unknown time zone")
      .optional(),
    // New fields - accept null values from frontend for optional fields
    headline: z.string().max(120).nullable().optional(),
    websiteUrl: z.string().url().nullable().optional().or(z.literal("")),
    twitterUrl: z.string().url().nullable().optional().or(z.literal("")),
    githubUrl: z.string().url().nullable().optional().or(z.literal("")),
    videoIntroUrl: z.string().url().nullable().optional().or(z.literal("")),
    languages: z.array(z.string()).nullable().optional(),
    toolsAndTechnologies: z.array(z.string()).nullable().optional(),
    mentoringStyle: z.string().nullable().optional(),
    offeringFormats: z
      .array(z.nativeEnum(OfferingFormat))
      .nullable()
      .optional(),
    // User-level field (stored on User model, not ConsultantProfile)
    linkedinUrl: z.string().url().nullable().optional().or(z.literal("")),
  })
  // #1703 — an unknown key is a 400, so a misspelt setting cannot be dropped silently.
  .strict()
  .refine(
    (data) => {
      if (data.scheduleType === "WEEKLY") {
        return (
          data.availabilityWindowsWeekly &&
          data.availabilityWindowsWeekly.length > 0
        );
      }
      if (data.scheduleType === "CUSTOM") {
        return (
          data.availabilityWindowsCustom &&
          data.availabilityWindowsCustom.length > 0
        );
      }
      return false;
    },
    {
      message: "Must provide corresponding slots array based on scheduleType",
      path: ["scheduleType"],
    },
  );

/**
 * `set` holds only the fields the user changed; `expect` holds the value the
 * screen showed for each of them. The write lands only while every expected
 * value still holds, so two tabs never silently undo each other.
 */
const bookingRequestSettingsSchema = z
  .object({ set: bookingRequestFields, expect: bookingRequestFields })
  .strict()
  .refine((data) => Object.keys(data.set).length > 0, {
    message: "Send at least one booking-request setting",
  })
  .refine((data) => Object.keys(data.set).every((key) => key in data.expect), {
    message: "Every changed setting needs the value it replaces",
  });

const BOOKING_SETTINGS_SELECT = {
  bookingMode: true,
  acceptingRequests: true,
  maxOpenRequests: true,
  maxActivePlanClients: true,
} as const;

/** The caller's own profile's owner, or the 401/403 response to return. */
async function authorizeOwner(
  id: string,
): Promise<{ userId: string } | NextResponse> {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const owner = await prisma.consultantProfile.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!owner || owner.userId !== session.user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  return owner;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { error: "Consultant ID is required" },
        { status: 400 },
      );
    }

    // Check if user is authenticated (for own profile access)
    const session = await getSession();

    // First, get basic consultant info to check access
    const basicConsultant = await prisma.consultantProfile.findUnique({
      where: { id },
      select: {
        userId: true,
        verificationStatus: true,
      },
    });

    if (!basicConsultant) {
      return NextResponse.json(
        { error: "Consultant not found" },
        { status: 404 },
      );
    }

    // Determine access level
    const isOwnProfile = session?.user?.id === basicConsultant.userId;
    const isAdmin = session?.user?.role === "ADMIN";
    const isVerified = basicConsultant.verificationStatus === "VERIFIED";

    // Block public access to unverified profiles
    if (!isVerified && !isOwnProfile && !isAdmin) {
      return NextResponse.json(
        { error: "Consultant not found" },
        { status: 404 },
      );
    }

    // Determine which user fields to include based on access level
    const isPrivilegedAccess = isOwnProfile || isAdmin;

    // #726 — public viewers must not see ORG_ONLY plans surfaced via the
    // consultant detail page. Privileged viewers (the consultant
    // themselves + ADMIN) see everything; the public include narrows
    // to PUBLIC + ORG_AND_PUBLIC.
    const planVisibilityFilter:
      { visibility: { in: OrgPlanVisibility[] } } | undefined =
      isPrivilegedAccess
        ? undefined
        : { visibility: { in: ["PUBLIC", "ORG_AND_PUBLIC"] } };
    // #1527 Q4 — 1:1 and subscription plans also hide drafts (and archived
    // rows) from the public include.
    const oneOnOnePlanFilter = isPrivilegedAccess
      ? undefined
      : oneOnOnePlanDiscoverableWhere();

    // Fetch consultant with appropriate user data
    const consultant = await prisma.consultantProfile.findUnique({
      where: { id },
      select: {
        ...consultantPublicScalars,
        // The plan-client limit is the owner's private setting.
        maxActivePlanClients: isPrivilegedAccess,
        user: isPrivilegedAccess
          ? {
              // Full user data for own profile or admin
              include: {
                workExperiences: {
                  orderBy: [{ isCurrent: "desc" }, { startDate: "desc" }],
                },
                education: {
                  orderBy: { endYear: "desc" },
                },
                certifications: {
                  orderBy: { issueDate: "desc" },
                },
              },
            }
          : { select: publicProfileUserSelect },
        domain: true,
        subDomains: true,
        tags: true,
        availabilityWindowsWeekly: true,
        availabilityWindowsCustom: true,
        consultationPlans: {
          ...(oneOnOnePlanFilter && { where: oneOnOnePlanFilter }),
          include: { faqs: { orderBy: { order: "asc" } } },
        },
        subscriptionPlans: {
          ...(oneOnOnePlanFilter && { where: oneOnOnePlanFilter }),
          include: {
            subscriptionContents: {
              orderBy: { order: "asc" },
            },
            faqs: { orderBy: { order: "asc" } },
          },
        },
        webinarPlans: planVisibilityFilter
          ? { where: planVisibilityFilter }
          : true,
        classPlans: planVisibilityFilter
          ? { where: planVisibilityFilter }
          : true,
        reviews: {
          where: { deletedAt: null },
          select: { id: true, rating: true },
          take: 5,
        },
      },
    });

    return NextResponse.json(
      // Zod output contract: fails closed if any statutory-PII key ever appears —
      // defense-in-depth over the select allowlist. (#946)
      { data: consultant ? consultantPublicApiSchema.parse(consultant) : null },
      {
        headers: isPrivilegedAccess
          ? // Owner/admin payloads vary by session: never shared-cache them,
            // and tell caches the response depends on the cookie.
            {
              "Cache-Control": "private, no-store",
              Vary: "Cookie",
            }
          : {
              "Cache-Control":
                "public, s-maxage=60, stale-while-revalidate=300",
              // The payload depends on who is signed in, so the shared copy is keyed on the session cookie.
              "Netlify-Vary":
                "cookie=__Secure-better-auth.session_token|better-auth.session_token",
            },
      },
    );
  } catch (error) {
    return apiError({ tag: "[Consultant.GET]", error, subsystem: "auth" });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const ownerCheck = await authorizeOwner(id);
    if (ownerCheck instanceof NextResponse) return ownerCheck;

    const read = await readJsonBody(request);
    if (read.error) return read.error;
    const requestData = read.body;

    // Validate request body using zod schema
    const validationResult = updateConsultantSchema.safeParse(requestData);
    if (!validationResult.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: validationResult.error.format(),
        },
        { status: 400 },
      );
    }

    const data = validationResult.data;
    const {
      description,
      experience,
      scheduleType,
      domainId,
      subDomainIds,
      tagIds,
      availabilityWindowsWeekly,
      availabilityWindowsCustom,
      // New fields
      headline,
      websiteUrl,
      twitterUrl,
      githubUrl,
      videoIntroUrl,
      languages,
      toolsAndTechnologies,
      mentoringStyle,
      offeringFormats,
      // User-level field
      linkedinUrl,
    } = data;

    // ------------------------------------------------------------------
    // Availability + scheduleType. Everything below the validation runs in
    // ONE Serializable transaction: the switch guard is re-read inside it
    // and the type flips through a CAS, so a booking that lands between the
    // pre-flight and the write is caught, and a crash can no longer leave
    // scheduleType flipped with the other type's rows still present (both
    // tables are replaced, as the onboarding sync does).
    // ------------------------------------------------------------------
    const existingConsultant = await prisma.consultantProfile.findUnique({
      where: { id },
      select: { scheduleType: true, user: { select: { timezone: true } } },
    });
    if (!existingConsultant) {
      return NextResponse.json(
        { error: "Consultant not found" },
        { status: 404 },
      );
    }
    const previousScheduleType = existingConsultant.scheduleType;
    const switching = previousScheduleType !== scheduleType;

    const switchBlocked = (active: ActiveAppointmentsResult) =>
      NextResponse.json(
        {
          error: `Cannot switch schedule type while you have ${active.total} active appointment(s). Please complete or cancel them first.`,
          code: "SCHEDULE_SWITCH_BLOCKED",
          breakdown: active.breakdown,
          details: active.details,
        },
        { status: 400 },
      );

    // Pre-flight so the common refusal costs no transaction; re-checked in-tx.
    if (switching) {
      const active = await checkActiveAppointments(id);
      if (active.hasActive) return switchBlocked(active);
    }

    // Build + validate the submitted set through the shared contract.
    const userTimezone = existingConsultant.user?.timezone ?? null;
    const rowTimezone = resolveWeeklyTimezone(
      data.weeklyTimezone ?? userTimezone,
    );
    let mergedWeekly: (Prisma.AvailabilityWindowWeeklyCreateManyInput & {
      startDay: DayOfWeek;
      startTimeUtc: number;
      endTimeUtc: number;
      utcOffsetMinutes: number;
    })[] = [];
    let mergedCustom: (Prisma.AvailabilityWindowCustomCreateManyInput & {
      startsAt: Date;
      endsAt: Date;
    })[] = [];

    if (scheduleType === ScheduleType.WEEKLY) {
      // Resolve the timezone offset once for all slots, through the one
      // resolver every write path shares (#1326).
      let utcOffsetMinutes: number;
      try {
        utcOffsetMinutes = resolveWeeklyUtcOffsetMinutes({
          profileTimezone: rowTimezone,
          callerSupplied: data.utcOffsetMinutes ?? null,
        });
      } catch (error) {
        if (error instanceof WeeklyOffsetConflictError) {
          return NextResponse.json(
            { error: error.message, code: error.code },
            { status: 400 },
          );
        }
        throw error;
      }
      // #1343 — dayOfWeekforStartTimeInUTC is the wire name the settings form
      // still sends; what it carries is the consultant's LOCAL day.
      const zoneRefusal = weeklyZoneRefusal(rowTimezone);
      if (zoneRefusal) {
        return NextResponse.json(
          { error: zoneRefusal.message, code: zoneRefusal.code },
          { status: AVAILABILITY_REFUSAL_STATUS[zoneRefusal.code] },
        );
      }
      const weeklySlotData = (availabilityWindowsWeekly ?? []).map((slot) => {
        const row = {
          consultantProfileId: id,
          startDay: slot.dayOfWeekforStartTimeInUTC,
          endDay: slot.dayOfWeekforEndTimeInUTC,
          startTimeUtc: dateToMinuteUtc(new Date(slot.startsAt)),
          endTimeUtc: dateToMinuteUtc(new Date(slot.endsAt)),
          utcOffsetMinutes,
        };
        return { ...row, ...weeklyLocalColumnsForSave(row, rowTimezone) };
      });
      const refusal = validateWeeklyWindows(weeklySlotData);
      if (refusal) {
        return NextResponse.json(
          { error: refusal.message, code: refusal.code, index: refusal.index },
          { status: AVAILABILITY_REFUSAL_STATUS[refusal.code] },
        );
      }
      // #1320 — merge adjacent entries on their local columns.
      mergedWeekly = mergeAdjacentWeeklyRows(weeklySlotData);
    } else {
      // #1780 R-2 — an unchanged window that has already ended is dropped,
      // not refused as PAST; a new past window still is.
      const existingCustom = await prisma.availabilityWindowCustom.findMany({
        where: { consultantProfileId: id },
        select: { startsAt: true, endsAt: true },
      });
      const customSlotData = dropUnchangedPastWindows(
        (availabilityWindowsCustom ?? []).map((slot) => ({
          consultantProfileId: id,
          startsAt: new Date(slot.startsAt),
          endsAt: new Date(slot.endsAt),
        })),
        existingCustom,
      );
      const refusal = validateCustomWindows(customSlotData);
      if (refusal) {
        return NextResponse.json(
          { error: refusal.message, code: refusal.code, index: refusal.index },
          { status: AVAILABILITY_REFUSAL_STATUS[refusal.code] },
        );
      }
      mergedCustom = mergeAdjacentCustomRows(customSlotData);
    }

    // The settings form asks first which bookings the new hours would leave
    // outside, and how many custom dates a weekly save removes; nothing is written.
    if (request.nextUrl.searchParams.get("preview") === "availability") {
      return NextResponse.json({
        preview: await previewNewlyUncovered(prisma, id, {
          scheduleType,
          weeklyRows: partitionWeeklyRows(
            mergedWeekly.map((row) => ({
              timezone: row.timezone ?? null,
              localStartDay: row.localStartDay ?? null,
              localStartMinutes: row.localStartMinutes ?? null,
              localEndDay: row.localEndDay ?? null,
              localEndMinutes: row.localEndMinutes ?? null,
            })),
          ).usable,
          customRows: mergedCustom,
        }),
      });
    }

    class SwitchBlockedInTx extends Error {
      constructor(readonly active: ActiveAppointmentsResult) {
        super("SCHEDULE_SWITCH_BLOCKED");
      }
    }
    class SwitchConflictInTx extends Error {}

    let uncoveredUpcoming: UncoveredUpcoming = NONE_UNCOVERED;
    try {
      await withSerializableRetry(() =>
        prisma.$transaction(
          async (tx) => {
            if (switching) {
              const active = await checkActiveAppointments(id, tx);
              if (active.hasActive) throw new SwitchBlockedInTx(active);
              const flipped = await tx.consultantProfile.updateMany({
                where: { id, scheduleType: previousScheduleType },
                data: { scheduleType },
              });
              if (flipped.count === 0) throw new SwitchConflictInTx();
            }

            await tx.consultantProfile.update({
              where: { id },
              data: {
                description,
                experience,
                domain: { connect: { id: domainId } },
                subDomains: { set: subDomainIds.map((id: string) => ({ id })) },
                tags: { set: tagIds.map((id: string) => ({ id })) },
                headline: headline ?? null,
                websiteUrl: websiteUrl || null,
                twitterUrl: twitterUrl || null,
                githubUrl: githubUrl || null,
                videoIntroUrl: videoIntroUrl || null,
                languages: languages ?? [],
                toolsAndTechnologies: toolsAndTechnologies ?? [],
                mentoringStyle: mentoringStyle ?? null,
                offeringFormats: offeringFormats ?? [],
              },
            });

            // linkedinUrl lives on User, not ConsultantProfile.
            if (linkedinUrl !== undefined) {
              await tx.user.update({
                where: { id: ownerCheck.userId },
                data: { linkedinUrl: linkedinUrl || null },
              });
            }

            // Replace BOTH tables — the dormant arm must not keep stale rows.
            await tx.availabilityWindowWeekly.deleteMany({
              where: { consultantProfileId: id },
            });
            await tx.availabilityWindowCustom.deleteMany({
              where: { consultantProfileId: id },
            });
            if (scheduleType === ScheduleType.WEEKLY) {
              await tx.availabilityWindowWeekly.createMany({
                data: mergedWeekly,
              });
            } else {
              await tx.availabilityWindowCustom.createMany({
                data: mergedCustom,
              });
            }

            // Shrink notice: which upcoming sessions now sit outside the new
            // hours. Reported, never refused — a booking is a contract, the
            // published hours are an offer for new ones.
            uncoveredUpcoming = (await settleAvailabilityWrite(tx, id))
              .uncoveredUpcoming;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 10_000,
            timeout: 15_000,
          },
        ),
      );
    } catch (error) {
      if (error instanceof SwitchBlockedInTx)
        return switchBlocked(error.active);
      if (error instanceof SwitchConflictInTx) {
        return NextResponse.json(
          {
            error:
              "Your schedule type changed in another tab. Reload and try again.",
            code: "SCHEDULE_SWITCH_CONFLICT",
          },
          { status: 409 },
        );
      }
      throw error;
    }

    // Headline, description, experience, domain and tags are all rendered on the
    // public profile and the directory cards, so an expert editing their profile
    // should see it live rather than wait out the ISR window.
    purgeExpertSurfaces(id);

    return NextResponse.json({ data: { id }, uncoveredUpcoming });
  } catch (error) {
    return apiError({ tag: "[Consultant.PUT]", error, subsystem: "auth" });
  }
}

/**
 * PATCH — the Booking requests settings, and the only writer of them. A CAS on
 * the values the screen showed: a change made elsewhere since then answers
 * 409 SETTINGS_CHANGED with the current values instead of being overwritten.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const owner = await authorizeOwner(id);
    if (owner instanceof NextResponse) return owner;

    const read = await readJsonBody(request);
    if (read.error) return read.error;
    const parsed = bookingRequestSettingsSchema.safeParse(read.body);
    if (!parsed.success) {
      // The plan-client limit's own sentence; anything else is a stale or hand-built body.
      const limitIssue = parsed.error.issues.find((issue) =>
        issue.path.includes("maxActivePlanClients"),
      );
      return NextResponse.json(
        {
          error:
            limitIssue?.message ??
            "These booking settings could not be saved. Reload the page and try again.",
          details: parsed.error.format(),
        },
        { status: 400 },
      );
    }

    const { set, expect } = parsed.data;
    const expected = {
      ...("bookingMode" in set && { bookingMode: expect.bookingMode }),
      ...("acceptingRequests" in set && {
        acceptingRequests: expect.acceptingRequests,
      }),
      ...("maxOpenRequests" in set && {
        maxOpenRequests: expect.maxOpenRequests,
      }),
      ...("maxActivePlanClients" in set && {
        maxActivePlanClients: expect.maxActivePlanClients,
      }),
    };
    const written = await prisma.consultantProfile.updateMany({
      where: { id, ...expected },
      data: set,
    });
    const data = await prisma.consultantProfile.findUnique({
      where: { id },
      select: BOOKING_SETTINGS_SELECT,
    });
    if (written.count === 0) {
      return NextResponse.json(
        {
          error:
            "Your booking settings were changed somewhere else. Reload to see the latest, then try again.",
          code: "SETTINGS_CHANGED",
          data,
        },
        { status: 409 },
      );
    }
    // The public page shows whether the expert is taking requests.
    purgeExpertSurfaces(id);
    return NextResponse.json({ data });
  } catch (error) {
    return apiError({
      tag: "[Consultant.PATCH]",
      error,
      subsystem: "consultants",
    });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    // Verify the caller owns this consultant profile
    const ownerCheck = await prisma.consultantProfile.findUnique({
      where: { id },
      select: {
        userId: true,
        deletedAt: true,
        // #781 §B / #2006 — earnings/organizationEarnings/payouts/TDS Restrict
        // this profile; a profile that ever moved money can only soft-delete.
        _count: {
          select: {
            earnings: true,
            organizationEarnings: true,
            payouts: true,
            tdsRecords: true,
          },
        },
      },
    });
    if (!ownerCheck || ownerCheck.userId !== session.user.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }
    if (ownerCheck.deletedAt) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const active = await checkActiveAppointments(id);
    if (active.hasActive) {
      return NextResponse.json(
        {
          error:
            "Cannot delete consultant profile while active or upcoming appointments exist.",
          code: "ACTIVE_APPOINTMENTS_BLOCK_DELETE",
          details: active.details,
        },
        { status: 400 },
      );
    }

    const hasMoneyHistory =
      ownerCheck._count.earnings +
        (ownerCheck._count.organizationEarnings ?? 0) +
        ownerCheck._count.payouts +
        ownerCheck._count.tdsRecords >
      0;

    if (hasMoneyHistory) {
      // Soft delete: financial rows (and the PAN they were withheld
      // against) survive for statutory retention. Slots go so nothing is
      // bookable; plans stay (historical bookings reference them) but the
      // browse/checkout surfaces filter deletedAt profiles out.
      // #1580 — the collaborations go with the profile: a deactivated
      // consultant must not keep a share on every future settlement.
      const collaborationsRemoved = await prisma.$transaction(async (tx) => {
        await tx.availabilityWindowWeekly.deleteMany({
          where: { consultantProfileId: id },
        });
        await tx.availabilityWindowCustom.deleteMany({
          where: { consultantProfileId: id },
        });
        await tx.consultantProfile.update({
          where: { id },
          data: { deletedAt: new Date() },
        });
        return endCollaborationsForUser(tx, session.user.id, {
          endedByUserId: session.user.id,
        });
      });
      await afterCollaborationEnded(
        collaborationsRemoved,
        "consultant.deactivate",
      );
      // deletedAt is one of the two public gates — the profile has just left
      // both public surfaces.
      purgeExpertSurfaces(id);
      return NextResponse.json({
        message: "Consultant deactivated (financial history retained)",
        softDeleted: true,
      });
    }

    // No money ever moved — full hard delete is safe. The collaborator rows
    // cascade with the profile, so their plans are captured in the same
    // transaction as the deletes, before the profile goes (#1580).
    const hardRemoved = await prisma.$transaction(async (tx) => {
      const removed = await endCollaborationsForUser(tx, session.user.id, {
        endedByUserId: session.user.id,
      });
      await tx.availabilityWindowWeekly.deleteMany({
        where: { consultantProfileId: id },
      });
      await tx.availabilityWindowCustom.deleteMany({
        where: { consultantProfileId: id },
      });
      await tx.consultationPlan.deleteMany({
        where: { consultantProfileId: id },
      });
      await tx.subscriptionPlan.deleteMany({
        where: { consultantProfileId: id },
      });
      await tx.webinarPlan.deleteMany({ where: { consultantProfileId: id } });
      await tx.classPlan.deleteMany({ where: { consultantProfileId: id } });
      await tx.consultantReview.deleteMany({
        where: { consultantProfileId: id },
      });
      if (typeof tx.payoutAccount?.deleteMany === "function") {
        await tx.payoutAccount.deleteMany({
          where: { consultantProfileId: id },
        });
      }
      await tx.consultantProfile.delete({ where: { id } });
      return removed;
    });
    await afterCollaborationEnded(hardRemoved, "consultant.delete");
    purgeExpertSurfaces(id);
    return NextResponse.json({ message: "Consultant deleted successfully" });
  } catch (error) {
    return apiError({ tag: "[Consultant.DELETE]", error, subsystem: "auth" });
  }
}
