/**
 * GET  /api/admin/referrals/credits
 * POST /api/admin/referrals/credits
 *
 * #1839 — Backoffice Referral Credits API.
 * - GET (`referrals.read` — Staff & Admin): paginated list of ReferralCredit
 *   rows with user identity, referral code, and usages, filterable by userId,
 *   search query `q` (email, name, referral code, userId, creditId), `source`,
 *   and derived `status` (`ACTIVE`, `EXHAUSTED`, `EXPIRED`, `REVERSED`).
 * - POST (`referrals.manage` via `withOpsAction` — Admin only): issue a
 *   goodwill / manual credit (`COMPENSATION` or `MANUAL`) with mandatory audit
 *   reason, `idempotencyKey`, and `issuedBy` actor stamp.
 */

import { NextRequest, NextResponse } from "next/server";
import { Prisma, type CreditSource, type Currency } from "@prisma/client";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal";
import { isUniqueViolationOn } from "@/lib/db/unique-violation";

const CreditSourceSchema = z.enum([
  "REFERRAL_BONUS",
  "REFEREE_BONUS",
  "PROMOTION",
  "COMPENSATION",
  "MANUAL",
]);

const CreditStatusFilterSchema = z.enum([
  "ACTIVE",
  "EXHAUSTED",
  "EXPIRED",
  "REVERSED",
]);

const GetQuerySchema = z.object({
  userId: z.string().trim().min(1).optional(),
  q: z.string().trim().max(200).optional(),
  source: CreditSourceSchema.optional(),
  status: CreditStatusFilterSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("referrals.read");
  if (auth.error) return auth.error;

  const sp = new URL(req.url).searchParams;
  const rawQuery: Record<string, string> = {};
  for (const key of ["userId", "q", "source", "status", "page", "limit"]) {
    const val = sp.get(key);
    if (val !== null && val.trim() !== "") {
      rawQuery[key] = val.trim();
    }
  }

  const parsed = GetQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues[0]?.message ?? "Invalid query parameters",
        code: "INVALID_QUERY",
      },
      { status: 400 },
    );
  }

  const { userId, q, source, status, page, limit } = parsed.data;
  const andConditions: Prisma.ReferralCreditWhereInput[] = [];

  if (userId) {
    andConditions.push({ userId });
  }
  if (source) {
    andConditions.push({ source: source as CreditSource });
  }
  if (q) {
    andConditions.push({
      OR: [
        { id: { contains: q, mode: "insensitive" } },
        { userId: { contains: q, mode: "insensitive" } },
        { user: { email: { contains: q, mode: "insensitive" } } },
        { user: { name: { contains: q, mode: "insensitive" } } },
        {
          user: {
            referralCode: {
              is: {
                OR: [
                  { code: { contains: q, mode: "insensitive" } },
                  { customCode: { contains: q, mode: "insensitive" } },
                ],
              },
            },
          },
        },
      ],
    });
  }

  const now = new Date();
  if (status === "REVERSED") {
    andConditions.push({ reversedAt: { not: null } });
  } else if (status === "EXHAUSTED") {
    andConditions.push({
      reversedAt: null,
      remainingAmount: 0,
    });
  } else if (status === "EXPIRED") {
    andConditions.push({
      reversedAt: null,
      remainingAmount: { gt: 0 },
      expiresAt: { lte: now },
    });
  } else if (status === "ACTIVE") {
    andConditions.push({
      reversedAt: null,
      remainingAmount: { gt: 0 },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    });
  }

  const where: Prisma.ReferralCreditWhereInput =
    andConditions.length > 0 ? { AND: andConditions } : {};

  const skip = (page - 1) * limit;
  const [credits, total] = await Promise.all([
    prisma.referralCredit.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            referralCode: {
              select: {
                code: true,
                customCode: true,
              },
            },
          },
        },
        usages: {
          select: {
            id: true,
            paymentId: true,
            amount: true,
            originalAmount: true,
            restoredAmount: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.referralCredit.count({ where }),
  ]);

  return NextResponse.json({
    data: credits,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  });
}

const IssueCreditShape = {
  userId: z.string().trim().min(1, "User ID or email is required"),
  amountPaise: z
    .number()
    .int("Amount in paise must be an integer")
    .positive("Amount in paise must be positive"),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.literal("INR"))
    .default("INR"),
  source: z.enum(["COMPENSATION", "MANUAL"]).default("COMPENSATION"),
  expiresAt: z.string().datetime().nullable().optional(),
  idempotencyKey: z.string().trim().min(1).max(160).optional(),
};

function matchesIdempotentCreditReplay(
  existing: {
    userId: string;
    amount: number | bigint;
    currency: string;
    source: string;
    expiresAt?: Date | string | null;
  },
  userId: string,
  body: {
    amountPaise: number;
    currency: string;
    source: string;
    expiresAt?: string | null;
  },
): boolean {
  const existingExpiryMs = existing.expiresAt
    ? new Date(existing.expiresAt).getTime()
    : null;
  const requestedExpiryMs = body.expiresAt
    ? new Date(body.expiresAt).getTime()
    : null;
  return (
    existing.userId === userId &&
    Number(existing.amount) === body.amountPaise &&
    existing.currency === body.currency &&
    existing.source === body.source &&
    existingExpiryMs === requestedExpiryMs
  );
}

export const POST = withOpsAction(
  "referrals.manage",
  "referrals.credit.issue",
  IssueCreditShape,
  {
    mode: "tx",
    run: async (tx, ctx) => {
      const { body, actor, opsActionId } = ctx;

      // Resolve user by id first, or by email if an email address was supplied.
      const user = body.userId.includes("@")
        ? await tx.user.findFirst({
            where: { email: { equals: body.userId, mode: "insensitive" } },
            select: { id: true, email: true, name: true },
          })
        : await tx.user.findUnique({
            where: { id: body.userId },
            select: { id: true, email: true, name: true },
          });

      if (!user) {
        throw new OpsRefusal("USER_NOT_FOUND", "Target user not found.", 404);
      }

      const idempotencyKey = body.idempotencyKey ?? `ops:${opsActionId}`;
      const existing = await tx.referralCredit.findUnique({
        where: { idempotencyKey },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          usages: true,
        },
      });
      if (existing) {
        if (matchesIdempotentCreditReplay(existing, user.id, body)) {
          return {
            target: { kind: "ReferralCredit", id: existing.id },
            status: 200,
            response: { credit: existing, replayed: true },
            after: {
              userId: existing.userId,
              amountPaise: Number(existing.amount),
              currency: existing.currency,
              source: existing.source,
              expiresAt: existing.expiresAt?.toISOString() ?? null,
              idempotencyKey,
              replayed: true,
            },
          };
        }
        throw new OpsRefusal(
          "DUPLICATE_IDEMPOTENCY_KEY",
          "A referral credit with this idempotency key already exists with a different payload.",
          409,
        );
      }

      const expiresAtDate = body.expiresAt ? new Date(body.expiresAt) : null;
      if (expiresAtDate && expiresAtDate <= new Date()) {
        throw new OpsRefusal(
          "INVALID_EXPIRY",
          "Expiration date must be in the future.",
          400,
        );
      }

      let credit;
      try {
        credit = await tx.referralCredit.create({
          data: {
            userId: user.id,
            amount: body.amountPaise,
            usedAmount: 0,
            remainingAmount: body.amountPaise,
            currency: body.currency as Currency,
            source: body.source,
            expiresAt: expiresAtDate,
            idempotencyKey,
            reason: body.reason,
            issuedBy: actor.userId,
          },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            usages: true,
          },
        });
      } catch (err) {
        if (isUniqueViolationOn(err, "idempotencyKey")) {
          const raced = await tx.referralCredit.findUnique({
            where: { idempotencyKey },
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                },
              },
              usages: true,
            },
          });
          if (raced && matchesIdempotentCreditReplay(raced, user.id, body)) {
            return {
              target: { kind: "ReferralCredit", id: raced.id },
              status: 200,
              response: { credit: raced, replayed: true },
              after: {
                userId: raced.userId,
                amountPaise: Number(raced.amount),
                currency: raced.currency,
                source: raced.source,
                expiresAt: raced.expiresAt?.toISOString() ?? null,
                idempotencyKey,
                replayed: true,
              },
            };
          }
          throw new OpsRefusal(
            "DUPLICATE_IDEMPOTENCY_KEY",
            "A referral credit with this idempotency key already exists.",
            409,
          );
        }
        throw err;
      }

      return {
        target: { kind: "ReferralCredit", id: credit.id },
        status: 201,
        response: { credit },
        after: {
          userId: user.id,
          amountPaise: body.amountPaise,
          currency: credit.currency,
          source: credit.source,
          idempotencyKey,
        },
      };
    },
  },
);
