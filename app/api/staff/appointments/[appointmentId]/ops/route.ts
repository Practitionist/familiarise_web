import { NextResponse } from "next/server";
import type { UserRole } from "@prisma/client";
import { z } from "zod";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { hasBackofficePermission } from "@/lib/auth/backoffice-permissions";
import { readBookingOps } from "@/lib/backoffice/booking-ops-read";

const OpsParams = z.object({ appointmentId: z.string().uuid() });

/** #1771 — one booking's sessions and money state for its Ops actions panel. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const auth = await requireBackofficeSurface("appointments.manage");
  if (auth.error) return auth.error;
  const parsed = OpsParams.safeParse(await params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid appointment id" },
      { status: 400 },
    );
  }
  const view = await readBookingOps(parsed.data.appointmentId);
  if (!view) {
    return NextResponse.json(
      { error: "Appointment not found" },
      { status: 404 },
    );
  }
  // The money state is a payments read; omit it if the matrix ever splits them.
  const role = auth.session.user.role as UserRole;
  const body = hasBackofficePermission(role, "payments.read")
    ? view
    : { ...view, payments: [] };
  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
}
