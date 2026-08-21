/**
 * #appt-support — per-appointment support thread. GET loads this user's thread +
 * messages; POST advances it one turn through the active resolver. Authz is the
 * same participation check the appointment-detail route uses (capability, not
 * UserRole), plus platform ADMIN/STAFF, plus (#support-hub) the org-party
 * branch: an org OPERATOR may open their OWN conversation on their org's
 * appointment, restricted to the org-party intents — never anyone else's
 * transcript (ADR 20).
 */

import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import prisma from "@/lib/prisma";
import {
  readAppointmentDetail,
  canAccessAppointment,
} from "@/lib/data/appointment-detail";
import { runSupportTurn } from "@/lib/support/service";
import { buildSupportContext } from "@/lib/support/context";
import { flowsForContext } from "@/lib/support/flows";

/** The intents an org operator may raise on a member's session. */
const ORG_PARTY_CATEGORIES = new Set(["ORG_ADMIN_DISPUTE", "SPONSORSHIP_BILLING"]);

const CATEGORY = z.enum([
  "CANCEL_REFUND",
  "RESCHEDULE",
  "NO_SHOW",
  "TECHNICAL",
  "PAYMENT_STATUS",
  "RECORDING_ACCESS",
  "QUALITY_COMPLAINT",
  "SPONSORSHIP_BILLING",
  "ORG_ADMIN_DISPUTE",
  "OTHER",
]);

const turnSchema = z
  .object({
    category: CATEGORY.optional(),
    chosenOptionId: z.string().max(200).optional(),
    userMessage: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.category || v.chosenOptionId || v.userMessage, {
    message: "A turn needs a category, a chosen option, or a message",
  });

async function authorize(appointmentId: string) {
  const session = await getSession();
  if (!session?.user?.id) return { error: "Unauthorized", status: 401 } as const;
  const detail = await readAppointmentDetail(appointmentId);
  if (!detail) return { error: "Appointment not found", status: 404 } as const;
  if (canAccessAppointment(session.user.id, detail)) {
    return { userId: session.user.id, isOrgParty: false } as const;
  }
  if (isPrivileged(session.user.role)) {
    return { userId: session.user.id, isOrgParty: false } as const;
  }
  // #support-hub — org-party branch. Grants the operator their OWN thread on
  // this appointment (org-party intents only); never widens read access to
  // another user's conversation.
  const orgId = detail.appointment.organizationId ?? null;
  if (orgId) {
    const membership = await prisma.membership.findFirst({
      where: {
        userId: session.user.id,
        organizationId: orgId,
        status: "ACTIVE",
      },
      select: { role: true },
    });
    if (membership && hasOrgPermission(membership.role, "operations.read")) {
      return { userId: session.user.id, isOrgParty: true } as const;
    }
  }
  return { error: "Forbidden", status: 403 } as const;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const parsed = z
      .object({ appointmentId: z.string().uuid() })
      .safeParse(await params);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid appointment id" }, { status: 400 });
    }
    const { appointmentId } = parsed.data;
    const auth = await authorize(appointmentId);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const thread = await prisma.appointmentSupportThread.findUnique({
      where: { appointmentId_userId: { appointmentId, userId: auth.userId } },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });

    // #support-hub — the intents the SERVER offers for this appointment
    // (stage/provider/org gating is server truth; the sheet renders exactly
    // this list instead of a hardcoded menu).
    let intents: { category: string; title: string }[] = [];
    try {
      const ctx = await buildSupportContext(
        thread?.id ?? "unstarted",
        appointmentId,
        auth.userId,
      );
      if (ctx) {
        intents = flowsForContext(ctx).map((f) => ({
          category: f.category,
          title: f.title,
        }));
      }
    } catch {
      // Intent resolution is an optimization — the sheet falls back to its
      // static list and the POST path still gates authoritatively.
    }

    return NextResponse.json({ data: thread, intents });
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json({ error: "Failed to load support thread" }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const parsed = z
      .object({ appointmentId: z.string().uuid() })
      .safeParse(await params);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid appointment id" }, { status: 400 });
    }
    const { appointmentId } = parsed.data;
    const auth = await authorize(appointmentId);
    if ("error" in auth) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const body = turnSchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) {
      return NextResponse.json(
        { error: body.error.issues[0]?.message ?? "Invalid turn" },
        { status: 400 },
      );
    }
    // Org parties raise only the org-party intents on someone else's session.
    if (
      auth.isOrgParty &&
      body.data.category &&
      !ORG_PARTY_CATEGORIES.has(body.data.category)
    ) {
      return NextResponse.json(
        { error: "This intent isn't available for organization operators here" },
        { status: 403 },
      );
    }

    const result = await runSupportTurn(appointmentId, auth.userId, {
      ...body.data,
      isOrgParty: auth.isOrgParty,
    });
    if (!result) {
      return NextResponse.json({ error: "Appointment not found" }, { status: 404 });
    }
    return NextResponse.json({ data: result });
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json({ error: "Failed to advance support thread" }, { status: 500 });
  }
}
