/**
 * #appt-support — per-appointment support thread. GET loads this user's thread +
 * messages; POST advances it one turn through the active resolver. Authz is the
 * same participation check the appointment-detail route uses (capability, not
 * UserRole), plus platform ADMIN/STAFF.
 */

import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import prisma from "@/lib/prisma";
import {
  readAppointmentDetail,
  canAccessAppointment,
} from "@/lib/data/appointment-detail";
import { runSupportTurn } from "@/lib/support/service";

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
  if (
    !canAccessAppointment(session.user.id, detail) &&
    !isPrivileged(session.user.role)
  ) {
    return { error: "Forbidden", status: 403 } as const;
  }
  return { userId: session.user.id } as const;
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
    return NextResponse.json({ data: thread });
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

    const result = await runSupportTurn(appointmentId, auth.userId, body.data);
    if (!result) {
      return NextResponse.json({ error: "Appointment not found" }, { status: 404 });
    }
    return NextResponse.json({ data: result });
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json({ error: "Failed to advance support thread" }, { status: 500 });
  }
}
