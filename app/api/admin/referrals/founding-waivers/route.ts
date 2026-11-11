/**
 * GET  /api/admin/referrals/founding-waivers — founding-expert waivers and the seats left (STAFF + ADMIN).
 * POST /api/admin/referrals/founding-waivers — ADMIN grant with a reason; count, expiry and cap from config.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import {
  readReferralProgramConfig,
  REFERRAL_CONFIG_ID,
} from "@/lib/referrals/program-config";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET() {
  const auth = await requireBackofficeSurface("referrals.read");
  if (auth.error) return auth.error;

  const [waivers, cfg] = await Promise.all([
    prisma.consultantFeeWaiver.findMany({
      where: { reason: "FOUNDING_EXPERT" },
      include: {
        consultantProfile: {
          select: {
            id: true,
            userId: true,
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    readReferralProgramConfig(),
  ]);

  const cap = cfg?.foundingExpertCap ?? 0;
  return NextResponse.json({
    data: waivers,
    granted: waivers.length,
    cap,
    remaining: Math.max(0, cap - waivers.length),
    sessionsPerGrant: cfg?.foundingWaiverSessions ?? null,
    validityDays: cfg?.foundingWaiverDays ?? null,
  });
}

export const POST = withOpsAction(
  "referrals.manage",
  "referrals.founding-waiver.grant",
  { consultantProfileId: z.string().trim().min(1).max(64) },
  {
    mode: "tx",
    run: async (tx, { body }) => {
      // The config row lock serialises grants, so the cap count below cannot be raced.
      await tx.$executeRaw`SELECT 1 FROM "ReferralProgramConfig" WHERE id = ${REFERRAL_CONFIG_ID} FOR UPDATE`;
      const cfg = await readReferralProgramConfig(tx);
      if (!cfg) {
        throw new OpsRefusal(
          "CONFIG_MISSING",
          "Create the referral programme config before granting founding waivers.",
          409,
        );
      }
      if (cfg.foundingWaiverSessions <= 0) {
        throw new OpsRefusal(
          "FOUNDING_WAIVER_OFF",
          "Founding waivers grant zero sessions in the current config.",
          409,
        );
      }

      const profile = await tx.consultantProfile.findUnique({
        where: { id: body.consultantProfileId },
        select: { id: true, verificationStatus: true },
      });
      if (!profile) {
        throw new OpsRefusal(
          "CONSULTANT_NOT_FOUND",
          "Consultant profile not found.",
          404,
        );
      }
      if (profile.verificationStatus !== "VERIFIED") {
        throw new OpsRefusal(
          "CONSULTANT_NOT_VERIFIED",
          "Only verified experts can receive a founding waiver.",
          409,
        );
      }

      const granted = await tx.consultantFeeWaiver.count({
        where: { reason: "FOUNDING_EXPERT" },
      });
      if (granted >= cfg.foundingExpertCap) {
        throw new OpsRefusal(
          "FOUNDING_CAP_REACHED",
          `All ${cfg.foundingExpertCap} founding-expert waivers have been granted.`,
          409,
          { granted, cap: cfg.foundingExpertCap },
        );
      }

      const expiresAt = new Date(Date.now() + cfg.foundingWaiverDays * DAY_MS);
      const waiver = await tx.consultantFeeWaiver
        .create({
          data: {
            consultantProfileId: profile.id,
            reason: "FOUNDING_EXPERT",
            sessionsRemaining: cfg.foundingWaiverSessions,
            expiresAt,
            referralId: null,
          },
        })
        .catch((err: unknown) => {
          if (isUniqueViolation(err)) {
            throw new OpsRefusal(
              "FOUNDING_WAIVER_EXISTS",
              "This expert already has a founding waiver.",
              409,
            );
          }
          throw err;
        });

      return {
        target: { kind: "ConsultantFeeWaiver", id: waiver.id },
        status: 201,
        response: { waiver, granted: granted + 1, cap: cfg.foundingExpertCap },
        after: {
          consultantProfileId: waiver.consultantProfileId,
          reason: waiver.reason,
          sessionsRemaining: waiver.sessionsRemaining,
          expiresAt: waiver.expiresAt.toISOString(),
          configVersion: cfg.version,
          granted: granted + 1,
          cap: cfg.foundingExpertCap,
        },
      };
    },
  },
);
