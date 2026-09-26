/**
 * GET/PUT /api/consultant/experience — the signed-in consultant's work
 * experience, education, certifications and achievements (#1527 §14).
 * Session-derived; the PUT replaces all four lists through the onboarding
 * writer and answers a validation refusal as a 400 with the first issue.
 */

import { NextResponse, type NextRequest } from "next/server";
import { requireOwnConsultantProfile } from "@/lib/api/consultant-profile";
import { apiError } from "@/lib/errors/api-error";
import { purgeExpertSurfaces } from "@/lib/data/public-cache";
import {
  ExperienceBodySchema,
  readConsultantExperience,
  writeConsultantExperience,
} from "@/lib/data/consultant-experience";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET() {
  try {
    const { session, profileId, error } = await requireOwnConsultantProfile();
    if (error) return error;
    const data = await readConsultantExperience(session.user.id, profileId);
    return NextResponse.json({ data }, { headers: NO_STORE });
  } catch (error) {
    return apiError({
      tag: "[Consultant.Experience.GET]",
      error,
      fallbackMessage: "Failed to load your experience",
    });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const { session, profileId, error } = await requireOwnConsultantProfile();
    if (error) return error;
    const parsed = ExperienceBodySchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return NextResponse.json(
        {
          error: issue?.message ?? "Check the highlighted entries",
          code: "INVALID_EXPERIENCE",
          field: issue?.path.join("."),
        },
        { status: 400, headers: NO_STORE },
      );
    }
    await writeConsultantExperience(session.user.id, profileId, parsed.data);
    // The public profile renders these; a cached page would hide the edit.
    purgeExpertSurfaces(profileId);
    const data = await readConsultantExperience(session.user.id, profileId);
    return NextResponse.json({ data }, { headers: NO_STORE });
  } catch (error) {
    return apiError({
      tag: "[Consultant.Experience.PUT]",
      error,
      fallbackMessage: "Failed to save your experience",
    });
  }
}
