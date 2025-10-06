/**
 * Database helper utilities for Playwright tests
 * Based on Supabase MCP queries from prompts/2.txt
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface ConsultantInfo {
  consultantProfileId: string;
  userId: string;
  name: string;
  email: string;
  scheduleType: string;
}

export interface AvailabilitySlot {
  id: string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  rawStart: Date;
  rawEnd: Date;
}

export interface BookedSlot {
  appointmentId: string;
  appointmentType: string;
  slotId: string;
  slotStartTimeInUTC: Date;
  slotEndTimeInUTC: Date;
  isTentative: boolean;
  bookingDate: string;
  bookingTime: string;
  consulteeName: string | null;
  status: string;
}

/**
 * Find a consultant with availability and pending requests
 */
export async function findTestConsultant(): Promise<ConsultantInfo | null> {
  const consultant = await prisma.$queryRaw<ConsultantInfo[]>`
    SELECT
      cp.id as "consultantProfileId",
      u.id as "userId",
      u.name,
      u.email,
      cp."scheduleType"
    FROM "ConsultantProfile" cp
    JOIN users u ON cp."userId" = u.id
    LEFT JOIN "SlotOfAvailabilityWeekly" sw ON sw."consultantProfileId" = cp.id
    LEFT JOIN "SlotOfAvailabilityCustom" sc ON sc."consultantProfileId" = cp.id
    GROUP BY cp.id, u.id, u.name, u.email, cp."scheduleType"
    HAVING COUNT(DISTINCT sw.id) > 0 OR COUNT(DISTINCT sc.id) > 0
    LIMIT 1
  `;

  return consultant[0] || null;
}

/**
 * Get weekly availability slots for a consultant
 */
export async function getWeeklyAvailability(consultantProfileId: string): Promise<AvailabilitySlot[]> {
  const slots = await prisma.$queryRaw<AvailabilitySlot[]>`
    SELECT
      id,
      "dayOfWeekforStartTimeInUTC" as "dayOfWeek",
      TO_CHAR("slotStartTimeInUTC", 'HH24:MI') as "startTime",
      TO_CHAR("slotEndTimeInUTC", 'HH24:MI') as "endTime",
      "slotStartTimeInUTC" as "rawStart",
      "slotEndTimeInUTC" as "rawEnd"
    FROM "SlotOfAvailabilityWeekly"
    WHERE "consultantProfileId" = ${consultantProfileId}
    ORDER BY
      CASE "dayOfWeekforStartTimeInUTC"
        WHEN 'MONDAY' THEN 1
        WHEN 'TUESDAY' THEN 2
        WHEN 'WEDNESDAY' THEN 3
        WHEN 'THURSDAY' THEN 4
        WHEN 'FRIDAY' THEN 5
        WHEN 'SATURDAY' THEN 6
        WHEN 'SUNDAY' THEN 7
      END,
      "slotStartTimeInUTC"
  `;

  return slots;
}

/**
 * Get all booked slots for a consultant
 */
export async function getBookedSlots(consultantProfileId: string): Promise<BookedSlot[]> {
  const slots = await prisma.$queryRaw<BookedSlot[]>`
    SELECT
      a.id as "appointmentId",
      a."appointmentType",
      sa.id as "slotId",
      sa."slotStartTimeInUTC",
      sa."slotEndTimeInUTC",
      sa."isTentative",
      TO_CHAR(sa."slotStartTimeInUTC", 'YYYY-MM-DD') as "bookingDate",
      TO_CHAR(sa."slotStartTimeInUTC", 'HH24:MI') as "bookingTime",
      consee.name as "consulteeName",
      COALESCE(
        cons."requestStatus"::text,
        subs."requestStatus"::text,
        cls.status::text,
        web.status::text
      ) as status
    FROM "Appointment" a
    JOIN "SlotOfAppointment" sa ON sa."appointmentId" = a.id
    JOIN "_SlotOfAppointmentToUser" su ON su."A" = sa.id
    JOIN users u ON su."B" = u.id
    LEFT JOIN "Consultation" cons ON a."consultationId" = cons.id
    LEFT JOIN "ConsulteeProfile" cp_consee ON cons."requestedById" = cp_consee.id
    LEFT JOIN users consee ON cp_consee."userId" = consee.id
    LEFT JOIN "Subscription" subs ON a."subscriptionId" = subs.id
    LEFT JOIN "Class" cls ON a."classId" = cls.id
    LEFT JOIN "Webinar" web ON a."webinarId" = web.id
    WHERE u."consultantProfileId" = ${consultantProfileId}
      AND sa."slotStartTimeInUTC" > NOW()
    ORDER BY sa."slotStartTimeInUTC"
    LIMIT 20
  `;

  return slots;
}

/**
 * Find pending consultation request
 */
export async function findPendingConsultation(consultantProfileId: string) {
  return await prisma.consultation.findFirst({
    where: {
      consultationPlan: {
        consultantProfileId,
      },
      requestStatus: 'PENDING',
      appointment: null,
    },
    include: {
      consultationPlan: true,
      requestedBy: {
        include: {
          user: true,
        },
      },
    },
  });
}

/**
 * Verify slots are consecutive (30 minutes apart)
 */
export async function verifyConsecutiveSlots(consultationId: string) {
  interface SlotInterval {
    slotStartTimeInUTC: Date;
    slotEndTimeInUTC: Date;
    previousEndTime: Date | null;
    gapSeconds: number | null;
    slotStatus: string;
  }

  const slots = await prisma.$queryRaw<SlotInterval[]>`
    WITH slot_intervals AS (
      SELECT
        sa."slotStartTimeInUTC",
        sa."slotEndTimeInUTC",
        LAG(sa."slotEndTimeInUTC") OVER (ORDER BY sa."slotStartTimeInUTC") as "previousEndTime",
        EXTRACT(EPOCH FROM (sa."slotStartTimeInUTC" - LAG(sa."slotEndTimeInUTC") OVER (ORDER BY sa."slotStartTimeInUTC"))) as "gapSeconds"
      FROM "SlotOfAppointment" sa
      JOIN "Appointment" a ON sa."appointmentId" = a.id
      WHERE a."consultationId" = ${consultationId}
      ORDER BY sa."slotStartTimeInUTC"
    )
    SELECT
      *,
      CASE
        WHEN "gapSeconds" IS NULL THEN 'FIRST_SLOT'
        WHEN "gapSeconds" <= 1 THEN 'CONSECUTIVE'
        ELSE 'GAP_DETECTED'
      END as "slotStatus"
    FROM slot_intervals
  `;

  return slots;
}

/**
 * Verify weekly distribution for subscription
 */
export async function verifyWeeklyDistribution(subscriptionId: string) {
  interface WeeklyDistribution {
    weekStart: Date;
    totalCalls: number;
    uniqueDaysInWeek: number;
    validationStatus: string;
  }

  const distribution = await prisma.$queryRaw<WeeklyDistribution[]>`
    WITH weekly_distribution AS (
      SELECT
        DATE_TRUNC('week', sa."slotStartTimeInUTC") as "weekStart",
        COUNT(DISTINCT DATE(sa."slotStartTimeInUTC")) as "uniqueDaysInWeek",
        COUNT(*) / 2 as "totalCalls"
      FROM "SlotOfAppointment" sa
      JOIN "Appointment" a ON sa."appointmentId" = a.id
      WHERE a."subscriptionId" = ${subscriptionId}
      GROUP BY "weekStart"
      ORDER BY "weekStart"
    )
    SELECT
      "weekStart",
      "totalCalls",
      "uniqueDaysInWeek",
      CASE
        WHEN "totalCalls" > 2 THEN '⚠️ EXCEEDS LIMIT'
        WHEN "uniqueDaysInWeek" < "totalCalls" THEN '⚠️ MULTIPLE CALLS SAME DAY'
        ELSE '✅ VALID'
      END as "validationStatus"
    FROM weekly_distribution
  `;

  return distribution;
}

/**
 * Check appointment details
 */
export async function getAppointmentDetails(consultationId: string) {
  interface AppointmentDetails {
    appointmentId: string;
    appointmentType: string;
    createdAt: Date;
    consultationStatus: string;
    slotCount: number;
    firstSlotStart: Date;
    lastSlotEnd: Date;
    uniqueDates: number;
  }

  const details = await prisma.$queryRaw<AppointmentDetails[]>`
    SELECT
      a.id as "appointmentId",
      a."appointmentType",
      a."createdAt",
      c."requestStatus" as "consultationStatus",
      COUNT(sa.id)::int as "slotCount",
      MIN(sa."slotStartTimeInUTC") as "firstSlotStart",
      MAX(sa."slotEndTimeInUTC") as "lastSlotEnd",
      COUNT(DISTINCT DATE(sa."slotStartTimeInUTC"))::int as "uniqueDates"
    FROM "Appointment" a
    JOIN "Consultation" c ON a."consultationId" = c.id
    JOIN "SlotOfAppointment" sa ON sa."appointmentId" = a.id
    WHERE c.id = ${consultationId}
    GROUP BY a.id, a."appointmentType", a."createdAt", c."requestStatus"
  `;

  return details[0] || null;
}

/**
 * Create a test consultation request
 */
export async function createTestConsultation(
  consultationPlanId: string,
  consulteeProfileId: string
) {
  return await prisma.consultation.create({
    data: {
      consultationPlanId,
      requestedById: consulteeProfileId,
      requestStatus: 'PENDING',
      requestedAt: new Date(),
    },
  });
}

/**
 * Cleanup test data
 */
export async function cleanupTestData(consultationId?: string, subscriptionId?: string) {
  if (consultationId) {
    await prisma.slotOfAppointment.deleteMany({
      where: {
        appointment: {
          consultationId,
        },
      },
    });
    await prisma.appointment.deleteMany({
      where: {
        consultationId,
      },
    });
    await prisma.consultation.delete({
      where: {
        id: consultationId,
      },
    });
  }

  if (subscriptionId) {
    await prisma.slotOfAppointment.deleteMany({
      where: {
        appointment: {
          subscriptionId,
        },
      },
    });
    await prisma.appointment.deleteMany({
      where: {
        subscriptionId,
      },
    });
  }
}

/**
 * Close database connection
 */
export async function closeDatabaseConnection() {
  await prisma.$disconnect();
}

export default prisma;
