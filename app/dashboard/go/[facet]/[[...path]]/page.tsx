import { redirect } from "next/navigation";

import { requireOnboarded } from "@/lib/auth-guard";
import {
  appointmentViewerSides,
  readAppointmentDetail,
} from "@/lib/data/appointment-detail";
import {
  goAppointmentId,
  resolveGoHref,
  sanitizeGoPath,
  type GoParticipation,
} from "@/lib/dashboard/go";

/**
 * #1527 — resolves a profile-less deep link (`/dashboard/go/auto/…`) to the
 * viewer's own dashboard URL. Auth-gated: requireOnboarded sends a signed-out
 * visitor to sign-in with this URL as the callback. The appointment read only
 * decides which side the viewer is on; the destination page re-checks access.
 */
export default async function GoPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ facet: string; path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const [{ facet, path }, query] = await Promise.all([params, searchParams]);
  const { user } = await requireOnboarded();

  let participation: GoParticipation | null = null;
  const safePath = sanitizeGoPath(path);
  const appointmentId =
    facet === "auto" && safePath ? goAppointmentId(safePath) : null;
  if (appointmentId) {
    const detail = await readAppointmentDetail(appointmentId);
    if (detail) {
      participation = {
        ...appointmentViewerSides(user.id, detail),
        organizationId: detail.appointment.organizationId ?? null,
      };
    }
  }

  const href = resolveGoHref(
    facet,
    path,
    {
      role: user.role,
      consultantProfileId: user.consultantProfileId,
      consulteeProfileId: user.consulteeProfileId,
      organizationIds: (user.organizationMemberships ?? []).map(
        (m) => m.organizationId,
      ),
    },
    participation,
  );

  // Carry plain string query params (e.g. ?tab=) through to the target.
  const forwarded = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") forwarded.set(key, value);
  }
  const suffix = forwarded.toString();
  redirect(suffix ? `${href}?${suffix}` : href);
}
