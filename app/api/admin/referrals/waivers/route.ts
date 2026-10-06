import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";
import { readReferralProgramConfig } from "@/lib/referrals/program-config";

const WaiverStatusFilterSchema = z.enum(["ACTIVE", "EXHAUSTED", "EXPIRED"]);
const WaiverReasonSchema = z.enum(["REFERRED_EXPERT", "REFERRING_EXPERT"]);

const GetWaiversQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: WaiverStatusFilterSchema.optional(),
  reason: WaiverReasonSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("referrals.read");
  if (auth.error) return auth.error;

  const sp = new URL(req.url).searchParams;
  const rawQuery: Record<string, string> = {};
  for (const key of ["q", "status", "reason", "page", "limit"]) {
    const val = sp.get(key);
    if (val !== null && val.trim() !== "") {
      rawQuery[key] = val.trim();
    }
  }

  const parsed = GetWaiversQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues[0]?.message ?? "Invalid query parameters",
        code: "INVALID_QUERY",
      },
      { status: 400 },
    );
  }

  const { q, status, reason, page, limit } = parsed.data;
  const andConditions: Prisma.ConsultantFeeWaiverWhereInput[] = [];

  if (reason) {
    andConditions.push({ reason });
  }
  if (q) {
    andConditions.push({
      OR: [
        { id: { contains: q, mode: "insensitive" } },
        { consultantProfileId: { contains: q, mode: "insensitive" } },
        { referralId: { contains: q, mode: "insensitive" } },
        {
          consultantProfile: {
            user: { email: { contains: q, mode: "insensitive" } },
          },
        },
        {
          consultantProfile: {
            user: { name: { contains: q, mode: "insensitive" } },
          },
        },
      ],
    });
  }

  const now = new Date();
  if (status === "ACTIVE") {
    andConditions.push({
      sessionsRemaining: { gt: 0 },
      expiresAt: { gt: now },
    });
  } else if (status === "EXHAUSTED") {
    andConditions.push({ sessionsRemaining: 0 });
  } else if (status === "EXPIRED") {
    andConditions.push({
      sessionsRemaining: { gt: 0 },
      expiresAt: { lte: now },
    });
  }

  const where: Prisma.ConsultantFeeWaiverWhereInput =
    andConditions.length > 0 ? { AND: andConditions } : {};

  const skip = (page - 1) * limit;
  const [waivers, total, config] = await Promise.all([
    prisma.consultantFeeWaiver.findMany({
      where,
      include: {
        consultantProfile: {
          select: {
            id: true,
            userId: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
        referral: {
          select: {
            id: true,
            status: true,
            configVersion: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.consultantFeeWaiver.count({ where }),
    readReferralProgramConfig(),
  ]);

  const data = waivers.map((w) => ({
    ...w,
    sessionsGranted: Math.max(
      w.sessionsRemaining,
      config?.expertWaiverSessions ?? 3,
    ),
  }));

  return NextResponse.json({
    data,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  });
}

const MutateWaiverShape = {
  action: z.enum(["GRANT", "REVOKE"]),
  waiverId: z.string().trim().min(1).optional(),
  consultantUserId: z.string().trim().min(1).optional(),
  referralId: z.string().trim().min(1).optional(),
  waiverReason: WaiverReasonSchema.default("REFERRED_EXPERT"),
  sessionsGranted: z.number().int().min(1).max(50).optional(),
  expiresAt: z.string().datetime().optional(),
};

export const POST = withOpsAction(
  "referrals.manage",
  "referrals.waiver.mutate",
  MutateWaiverShape,
  {
    mode: "tx",
    run: async (tx, { body }) => {
      if (body.action === "REVOKE") {
        if (!body.waiverId) {
          throw new OpsRefusal(
            "MISSING_WAIVER_ID",
            "Waiver ID is required to revoke a fee waiver.",
            400,
          );
        }

        const existing = await tx.consultantFeeWaiver.findUnique({
          where: { id: body.waiverId },
        });
        if (!existing) {
          throw new OpsRefusal(
            "WAIVER_NOT_FOUND",
            "Fee waiver not found.",
            404,
          );
        }
        if (existing.sessionsRemaining === 0) {
          throw new OpsRefusal(
            "ALREADY_EXHAUSTED",
            "Fee waiver already has zero sessions remaining.",
            409,
          );
        }

        const updated = await tx.consultantFeeWaiver.updateMany({
          where: {
            id: existing.id,
            sessionsRemaining: existing.sessionsRemaining,
          },
          data: { sessionsRemaining: 0 },
        });
        if (updated.count === 0) {
          throw new OpsRefusal(
            "CONCURRENT_UPDATE",
            "Fee waiver was modified concurrently; retry.",
            409,
          );
        }

        const refreshed = await tx.consultantFeeWaiver.findUnique({
          where: { id: existing.id },
        });

        return {
          target: { kind: "ConsultantFeeWaiver", id: existing.id },
          status: 200,
          response: { waiver: refreshed },
          before: { sessionsRemaining: existing.sessionsRemaining },
          after: { sessionsRemaining: 0 },
        };
      }

      const cfg = await readReferralProgramConfig(tx);
      const sessionsToGrant =
        body.sessionsGranted ?? cfg?.expertWaiverSessions ?? 3;
      if (sessionsToGrant <= 0) {
        throw new OpsRefusal(
          "INVALID_SESSIONS",
          "Sessions granted must be at least 1.",
          400,
        );
      }

      const defaultExpiresAt = new Date(
        Date.now() + (cfg?.expertWaiverDays ?? 90) * 24 * 60 * 60 * 1000,
      );
      const expiresAtDate = body.expiresAt
        ? new Date(body.expiresAt)
        : defaultExpiresAt;
      if (expiresAtDate <= new Date()) {
        throw new OpsRefusal(
          "INVALID_EXPIRY",
          "Expiration date must be in the future.",
          400,
        );
      }

      if (body.waiverId) {
        const existing = await tx.consultantFeeWaiver.findUnique({
          where: { id: body.waiverId },
        });
        if (!existing) {
          throw new OpsRefusal(
            "WAIVER_NOT_FOUND",
            "Fee waiver not found.",
            404,
          );
        }

        const updated = await tx.consultantFeeWaiver.update({
          where: { id: existing.id },
          data: {
            sessionsRemaining: sessionsToGrant,
            expiresAt: expiresAtDate,
          },
        });

        return {
          target: { kind: "ConsultantFeeWaiver", id: updated.id },
          status: 200,
          response: { waiver: updated },
          before: {
            sessionsRemaining: existing.sessionsRemaining,
            expiresAt: existing.expiresAt.toISOString(),
          },
          after: {
            sessionsRemaining: updated.sessionsRemaining,
            expiresAt: updated.expiresAt.toISOString(),
          },
        };
      }

      if (!body.consultantUserId) {
        throw new OpsRefusal(
          "MISSING_CONSULTANT",
          "Consultant user ID, email, or profile ID is required.",
          400,
        );
      }

      const targetLookup = body.consultantUserId;
      const profile = targetLookup.includes("@")
        ? await tx.consultantProfile.findFirst({
            where: {
              user: { email: { equals: targetLookup, mode: "insensitive" } },
            },
            select: { id: true, userId: true },
          })
        : await tx.consultantProfile.findFirst({
            where: {
              OR: [{ id: targetLookup }, { userId: targetLookup }],
            },
            select: { id: true, userId: true },
          });

      if (!profile) {
        throw new OpsRefusal(
          "CONSULTANT_NOT_FOUND",
          "Target consultant profile not found.",
          404,
        );
      }

      let referralId = body.referralId;
      if (!referralId) {
        const existingReferral =
          body.waiverReason === "REFERRED_EXPERT"
            ? await tx.referral.findFirst({
                where: { referredUserId: profile.userId },
                orderBy: { createdAt: "desc" },
                select: { id: true },
              })
            : await tx.referral.findFirst({
                where: { referralCode: { userId: profile.userId } },
                orderBy: { createdAt: "desc" },
                select: { id: true },
              });

        if (!existingReferral) {
          throw new OpsRefusal(
            "REFERRAL_NOT_FOUND",
            "No qualifying referral exists for this expert and waiver reason; specify a referralId or create a referral first.",
            404,
          );
        }
        referralId = existingReferral.id;
      }

      const waiver = await tx.consultantFeeWaiver.upsert({
        where: {
          referralId_consultantProfileId: {
            referralId,
            consultantProfileId: profile.id,
          },
        },
        update: {
          sessionsRemaining: sessionsToGrant,
          expiresAt: expiresAtDate,
          reason: body.waiverReason,
        },
        create: {
          consultantProfileId: profile.id,
          referralId,
          reason: body.waiverReason,
          sessionsRemaining: sessionsToGrant,
          expiresAt: expiresAtDate,
        },
      });

      return {
        target: { kind: "ConsultantFeeWaiver", id: waiver.id },
        status: 201,
        response: { waiver },
        after: {
          consultantProfileId: waiver.consultantProfileId,
          referralId: waiver.referralId,
          reason: waiver.reason,
          sessionsRemaining: waiver.sessionsRemaining,
          expiresAt: waiver.expiresAt.toISOString(),
        },
      };
    },
  },
);
