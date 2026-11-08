/**
 * Newsletter subscription service.
 *
 * Double opt-in: a signup lands as PENDING and only becomes SUBSCRIBED after
 * the confirm link is clicked. Nothing here throws on a bad email or a repeat
 * signup — the public route must stay enumeration-safe, so callers get a
 * result object and render the same copy either way.
 */

import * as Sentry from "@sentry/nextjs";
import { Prisma, NewsletterSource, NewsletterStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import { canSignLinks } from "@/lib/auth/link-signing";
import {
  sendNewsletterConfirmEmail,
  sendNewsletterWelcomeEmail,
} from "@/lib/email";
import type { BroadcastAudience } from "./broadcast-audience";
import { verifyConfirmToken, verifyUnsubscribeToken } from "./tokens";
import {
  hashIp,
  lockNewsletterRows,
  newsletterSubjectId,
  normalizeNewsletterEmail,
  recordNewsletterConsent,
  withdrawNewsletterConsent,
} from "./consent-link";

export type SubscribeInput = {
  email: string;
  name?: string | null;
  source?: NewsletterSource;
  tags?: string[];
  /** The signed-in account; the row is linked only when it owns the submitted address. */
  sessionUser?: { id: string; email: string; emailVerified: boolean } | null;
  /** Raw request IP — hashed before it touches the database. */
  ip?: string | null;
  userAgent?: string | null;
};

export type SubscribeResult =
  | { outcome: "CONFIRMATION_SENT" }
  | { outcome: "ALREADY_SUBSCRIBED" }
  /** Row is on the list as PENDING but the confirmation could not be sent. */
  | { outcome: "CONFIRMATION_FAILED" };

/**
 * Upsert the address into the list and send a confirmation.
 *
 * A previously unsubscribed address goes back to PENDING rather than straight
 * to SUBSCRIBED: re-consent has to be a fresh click, not a side effect of
 * someone re-entering an address.
 */
export async function subscribe(
  input: SubscribeInput,
): Promise<SubscribeResult> {
  const email = normalizeNewsletterEmail(input.email);
  const now = new Date();
  const owner = input.sessionUser;
  const userId =
    owner?.emailVerified && normalizeNewsletterEmail(owner.email) === email
      ? owner.id
      : null;

  // Checked before the membership lookup, deliberately. If this ran after the
  // ALREADY_SUBSCRIBED short-circuit, a signing outage would answer 200 for
  // subscribed addresses and fail for everyone else — letting a caller probe
  // membership by status code. Config health must not depend on the address.
  if (!canSignLinks()) {
    Sentry.captureMessage("newsletter signing key unavailable", {
      level: "error",
      tags: { subsystem: "newsletter" },
    });
    return { outcome: "CONFIRMATION_FAILED" };
  }

  const existing = await prisma.newsletterSubscriber.findUnique({
    where: { email },
    select: { status: true },
  });

  if (existing?.status === NewsletterStatus.SUBSCRIBED) {
    return { outcome: "ALREADY_SUBSCRIBED" };
  }

  const consent = {
    consentIpHash: hashIp(input.ip),
    consentUserAgent: input.userAgent?.slice(0, 500) ?? null,
  };

  await prisma.newsletterSubscriber.upsert({
    where: { email },
    create: {
      email,
      name: input.name ?? null,
      status: NewsletterStatus.PENDING,
      source: input.source ?? NewsletterSource.FOOTER,
      tags: input.tags ?? [],
      userId,
      ...consent,
    },
    update: {
      status: NewsletterStatus.PENDING,
      unsubscribedAt: null,
      confirmedAt: null,
      // A re-signup from a different surface retags the row; the original
      // source is not worth preserving once someone opts in again.
      ...(input.source ? { source: input.source } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(userId ? { userId } : {}),
      ...consent,
    },
  });

  const sent = await sendNewsletterConfirmEmail({
    email,
    name: input.name ?? null,
    issuedAt: now.getTime(),
  });

  if (!sent.success) {
    // The row is written and the address is on the list; only the email
    // failed. Report it rather than claiming a confirmation went out — the
    // subscriber is otherwise stuck at PENDING with no way to advance.
    // The reason is carried through so every failure isn't one flat warning;
    // neither the address nor the signed link is included.
    const reason = sent.error;
    if (reason instanceof Error) {
      Sentry.captureException(reason, {
        level: "warning",
        tags: { subsystem: "newsletter" },
      });
    } else {
      Sentry.captureMessage(
        `newsletter confirmation email failed to send: ${String(reason)}`,
        { level: "warning", tags: { subsystem: "newsletter" } },
      );
    }
    return { outcome: "CONFIRMATION_FAILED" };
  }

  return { outcome: "CONFIRMATION_SENT" };
}

export type ConfirmResult =
  | { outcome: "CONFIRMED" }
  | { outcome: "ALREADY_CONFIRMED" }
  | { outcome: "INVALID" };

/**
 * Confirms a sign-up and records its `MARKETING_COMMS` consent in one
 * transaction; a matching account is linked to the row and the artifact.
 */
export async function confirmSubscription(params: {
  email: string;
  token: string;
  issuedAt: number;
}): Promise<ConfirmResult> {
  const email = normalizeNewsletterEmail(params.email);

  if (!verifyConfirmToken(email, params.token, params.issuedAt)) {
    return { outcome: "INVALID" };
  }

  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.newsletterSubscriber.findUnique({
      where: { email },
      select: { status: true, name: true, consentSubjectId: true },
    });
    if (!existing) return { outcome: "INVALID" } as const;
    if (existing.status === NewsletterStatus.SUBSCRIBED) {
      return { outcome: "ALREADY_CONFIRMED" } as const;
    }
    // Kept once written, so a later key rotation still finds the artifact.
    const subjectId = existing.consentSubjectId ?? newsletterSubjectId(email);
    // The account that owns the confirmed address, never a stored id that may not.
    const userId =
      (
        await tx.user.findUnique({
          where: { email },
          select: { id: true },
        })
      )?.id ?? null;
    const { count } = await tx.newsletterSubscriber.updateMany({
      where: { email, status: { not: NewsletterStatus.SUBSCRIBED } },
      data: {
        status: NewsletterStatus.SUBSCRIBED,
        confirmedAt: now,
        unsubscribedAt: null,
        userId,
        consentSubjectId: subjectId,
      },
    });
    if (count === 0) return { outcome: "ALREADY_CONFIRMED" } as const;
    await recordNewsletterConsent(tx, { email, userId, subjectId, now });
    return { outcome: "CONFIRMED", name: existing.name } as const;
  });

  if (result.outcome !== "CONFIRMED") return result;
  await sendNewsletterWelcomeEmail({ email, name: result.name });
  return { outcome: "CONFIRMED" };
}

/**
 * Always reports success for a valid token. An unsubscribe endpoint that
 * distinguished "you were on the list" from "you were not" would leak
 * membership to anyone holding a valid token for a guessed address.
 * The status change and the consent withdrawal commit together.
 */
export async function unsubscribe(params: {
  email: string;
  token: string;
}): Promise<{ ok: boolean }> {
  const email = normalizeNewsletterEmail(params.email);

  if (!verifyUnsubscribeToken(email, params.token)) {
    return { ok: false };
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const [row] = await lockNewsletterRows(tx, { email }, now);
    await tx.newsletterSubscriber.updateMany({
      where: { email, status: { not: NewsletterStatus.UNSUBSCRIBED } },
      data: { status: NewsletterStatus.UNSUBSCRIBED, unsubscribedAt: now },
    });
    await withdrawNewsletterConsent(tx, {
      email,
      userId: row?.userId ?? null,
      subjectId: row?.consentSubjectId ?? null,
      now,
    });
  });
  return { ok: true };
}

export type SubscriberFilters = {
  status?: NewsletterStatus;
  source?: NewsletterSource;
  search?: string;
  page?: number;
  perPage?: number;
};

function buildWhere(
  filters: SubscriberFilters,
): Prisma.NewsletterSubscriberWhereInput {
  return {
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.search
      ? {
          OR: [
            {
              email: { contains: filters.search, mode: "insensitive" as const },
            },
            {
              name: { contains: filters.search, mode: "insensitive" as const },
            },
          ],
        }
      : {}),
  };
}

export async function listSubscribers(filters: SubscriberFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const perPage = Math.min(100, Math.max(1, filters.perPage ?? 50));
  const where = buildWhere(filters);

  const [items, total, byStatus] = await prisma.$transaction([
    prisma.newsletterSubscriber.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        source: true,
        tags: true,
        confirmedAt: true,
        unsubscribedAt: true,
        createdAt: true,
      },
    }),
    prisma.newsletterSubscriber.count({ where }),
    prisma.newsletterSubscriber.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
  ]);

  const stats = Object.fromEntries(
    Object.values(NewsletterStatus).map((status) => [
      status,
      byStatus.find((row) => row.status === status)?._count._all ?? 0,
    ]),
  ) as Record<NewsletterStatus, number>;

  return { items, total, page, perPage, stats };
}

function roleWhere(
  role: BroadcastAudience["role"],
): Prisma.NewsletterSubscriberWhereInput {
  switch (role) {
    case "EXPERT":
      return { user: { is: { consultantProfile: { isNot: null } } } };
    case "LEARNER":
      return { user: { is: { consultantProfile: { is: null } } } };
    case "NO_ACCOUNT":
      return { userId: null };
    default:
      return {};
  }
}

export function audienceWhere(
  audience: BroadcastAudience,
): Prisma.NewsletterSubscriberWhereInput {
  return {
    status: NewsletterStatus.SUBSCRIBED,
    ...(audience.sources?.length ? { source: { in: audience.sources } } : {}),
    ...(audience.tags?.length ? { tags: { hasSome: audience.tags } } : {}),
    ...roleWhere(audience.role),
  };
}

/**
 * Addresses a broadcast audience may go to. `stable` (signup order) keeps every earlier
 * 100-recipient batch, and so its idempotency key, unchanged when new rows arrive;
 * `recentFirst` is for the warm-up only.
 */
export function listSendableSubscribers(
  audience: BroadcastAudience,
  order: "stable" | "recentFirst",
) {
  return prisma.newsletterSubscriber.findMany({
    where: audienceWhere(audience),
    select: { email: true },
    orderBy:
      order === "stable"
        ? [{ createdAt: "asc" }, { id: "asc" }]
        : [{ confirmedAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
  });
}

function csvCell(value: string | null | undefined = ""): string {
  const raw = value ?? "";
  // Guard against a leading =, +, - or @ being interpreted as a formula when
  // the export is opened in a spreadsheet.
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

export async function exportSubscribersCsv(
  filters: SubscriberFilters,
): Promise<string> {
  const rows = await prisma.newsletterSubscriber.findMany({
    where: buildWhere(filters),
    orderBy: { createdAt: "desc" },
    select: {
      email: true,
      name: true,
      status: true,
      source: true,
      tags: true,
      confirmedAt: true,
      unsubscribedAt: true,
      createdAt: true,
    },
  });

  const header = [
    "email",
    "name",
    "status",
    "source",
    "tags",
    "confirmedAt",
    "unsubscribedAt",
    "createdAt",
  ].join(",");

  const body = rows.map((row) =>
    [
      csvCell(row.email),
      csvCell(row.name),
      csvCell(row.status),
      csvCell(row.source),
      csvCell(row.tags.join(" ")),
      csvCell(row.confirmedAt?.toISOString()),
      csvCell(row.unsubscribedAt?.toISOString()),
      csvCell(row.createdAt.toISOString()),
    ].join(","),
  );

  return [header, ...body].join("\n");
}
