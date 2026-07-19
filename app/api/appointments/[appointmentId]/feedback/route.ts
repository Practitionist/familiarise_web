/**
 * #appt-support — private per-participant CSAT for an appointment (1–5 + note),
 * distinct from the public ConsultantReview. One per (appointment, user), upsert
 * so re-submitting edits. Gives webinar/class attendees a feedback path they
 * lacked and feeds an org-level quality signal.
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

const feedbackSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).optional(),
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
  return {
    userId: session.user.id,
    organizationId: detail.appointment.organizationId ?? null,
  } as const;
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
    const feedback = await prisma.appointmentFeedback.findUnique({
      where: { appointmentId_userId: { appointmentId, userId: auth.userId } },
    });
    return NextResponse.json({ data: feedback });
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json({ error: "Failed to load feedback" }, { status: 500 });
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

    const body = feedbackSchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) {
      return NextResponse.json(
        { error: body.error.issues[0]?.message ?? "Invalid feedback" },
        { status: 400 },
      );
    }

    const feedback = await prisma.appointmentFeedback.upsert({
      where: { appointmentId_userId: { appointmentId, userId: auth.userId } },
      create: {
        appointmentId,
        userId: auth.userId,
        organizationId: auth.organizationId,
        rating: body.data.rating,
        comment: body.data.comment,
      },
      update: { rating: body.data.rating, comment: body.data.comment },
    });
    return NextResponse.json({ data: feedback });
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json({ error: "Failed to save feedback" }, { status: 500 });
  }
}
