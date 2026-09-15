/**
 * #1653 — one-click unsubscribe from optional email notifications.
 *
 * GET  — a human clicked the footer link. Verifies the token and sends them to
 *        the confirmation page; flips nothing, because link scanners prefetch.
 * POST — RFC 8058 one-click from Gmail/Yahoo via List-Unsubscribe-Post, or the
 *        confirmation page's form. Flips `emailEnabled` only: the category
 *        switches are shared with the bell, and the bell was not the complaint.
 *
 * The token is the only guard; no session and no rate limit. The response
 * never says whether the user exists.
 */

import * as Sentry from "@sentry/nextjs";
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { verifyEmailUnsubscribeToken } from "@/lib/email/unsubscribe";
import { updateSubscriberPreferences } from "@/lib/novu/subscriber";
import { getAppUrl } from "@/lib/url";

export const dynamic = "force-dynamic";

const PAGE_PATH = "/email/unsubscribe";

// The token is a hex HMAC-SHA256 digest; anything else is rejected before
// the signature check runs.
const linkSchema = z.object({
  u: z.string().min(1),
  t: z.string().regex(/^[0-9a-f]{64}$/),
});

function readLink(request: NextRequest): { userId: string; valid: boolean } {
  const { searchParams } = new URL(request.url);
  const parsed = linkSchema.safeParse({
    u: searchParams.get("u") ?? "",
    t: searchParams.get("t") ?? "",
  });
  if (!parsed.success) return { userId: "", valid: false };
  const { u: userId, t: token } = parsed.data;
  return { userId, valid: verifyEmailUnsubscribeToken(userId, token) };
}

function toPage(query: string): NextResponse {
  return NextResponse.redirect(`${getAppUrl()}${PAGE_PATH}?${query}`, 303);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { valid } = readLink(request);
  if (!valid) return toPage("error=1");
  const { search } = new URL(request.url);
  return toPage(search.slice(1));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const { userId, valid } = readLink(request);
  // The page's <form> wants to land back on the page; a mail client wants JSON.
  const wantsHtml =
    request.headers.get("accept")?.includes("text/html") ?? false;

  if (!valid) {
    return wantsHtml
      ? toPage("error=1")
      : NextResponse.json({ error: "invalid link" }, { status: 400 });
  }

  try {
    const updated = await prisma.notificationPreference.upsert({
      where: { userId },
      update: { emailEnabled: false },
      create: { userId, emailEnabled: false },
    });
    // Mirrors PUT /api/novu/preferences so Novu's copy of the flags agrees;
    // a Novu failure must never fail the unsubscribe.
    try {
      await updateSubscriberPreferences(userId, {
        inApp: updated.inAppEnabled,
        email: false,
        push: updated.pushEnabled,
        appointmentReminders: updated.appointmentReminders,
        paymentNotifications: updated.paymentNotifications,
        supportUpdates: updated.supportUpdates,
        feedbackAlerts: updated.feedbackAlerts,
        trialNotifications: updated.trialNotifications,
        subscriptionAlerts: updated.subscriptionAlerts,
        marketingEmails: updated.marketingEmails,
        orgBillingAlerts: updated.orgBillingAlerts,
        orgMembershipAlerts: updated.orgMembershipAlerts,
        orgProgramAlerts: updated.orgProgramAlerts,
      });
    } catch (novuError) {
      Sentry.captureException(
        novuError instanceof Error ? novuError : new Error(String(novuError)),
        { tags: { subsystem: "notifications" }, level: "warning" },
      );
    }
  } catch (error) {
    // P2003: no such user. A signed link for an id that no longer exists
    // answers exactly like a real one so the route is not an oracle.
    const unknownUser =
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003";
    if (!unknownUser) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "notifications" } },
      );
      console.error("[notifications/unsubscribe]", error);
      return NextResponse.json(
        { error: "unsubscribe failed" },
        { status: 500 },
      );
    }
  }

  return wantsHtml ? toPage("done=1") : NextResponse.json({ ok: true });
}
