"use server";

import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import {
  prepareDraftForPersist,
  readStoredDraftPayload,
  type DraftActionResult,
  type LoadDraftActionResult,
  type OnboardingDraftSnapshot,
  type SaveDraftActionResult,
} from "@/utils/onboarding-draft";
import { canAddConsultantIdentity } from "@/utils/onboarding-shared";
import { applyRateLimit, onboardingDraftLimiter } from "@/lib/rate-limit";

/**
 * Resumable-onboarding drafts, keyed by the session user only. The draft is a
 * convenience cache and never an authorization input. Saves are CAS on
 * `OnboardingDraft.version`; a stale base returns DRAFT_CONFLICT.
 */

function unauthorized(): { success: false; error: string } {
  return { success: false, error: "Unauthorized" };
}

export async function saveOnboardingDraftAction(
  input: unknown,
): Promise<SaveDraftActionResult> {
  const session = await getSession();
  if (!session?.user?.id) return unauthorized();
  const user = session.user;

  // A finished account has no draft to keep, except while adding an identity.
  if (user.onboardingCompleted === true && !canAddConsultantIdentity(user)) {
    return {
      success: false,
      code: "ONBOARDED",
      error: "Onboarding is already complete.",
    };
  }

  const limited = await applyRateLimit(onboardingDraftLimiter, user.id);
  if (limited) {
    return {
      success: false,
      error: "Too many requests. Please try again later.",
    };
  }

  const prepared = prepareDraftForPersist(input);
  if (prepared === null) {
    return { success: false, error: "Invalid or oversized draft payload" };
  }

  const data = {
    role: prepared.role,
    currentStep: prepared.currentStep,
    payload: prepared.payload as Prisma.InputJsonValue,
  };
  const { count } = await prisma.onboardingDraft.updateMany({
    where: { userId: user.id, version: prepared.baseVersion },
    data: { ...data, version: { increment: 1 } },
  });
  if (count === 1) return { success: true, version: prepared.baseVersion + 1 };

  if (prepared.baseVersion === 0) {
    try {
      await prisma.onboardingDraft.create({
        data: { userId: user.id, ...data, version: 1 },
      });
      return { success: true, version: 1 };
    } catch (error) {
      const raced =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002";
      if (!raced) throw error;
    }
  }

  const stored = await prisma.onboardingDraft.findUnique({
    where: { userId: user.id },
    select: { version: true },
  });
  return {
    success: false,
    code: "DRAFT_CONFLICT",
    error: "Newer edits were saved on another device.",
    currentVersion: stored?.version ?? 0,
  };
}

export async function loadOnboardingDraftAction(): Promise<LoadDraftActionResult> {
  // A failure is reported, not thrown: the wizard keeps autosave off until a
  // load succeeds, so a blip cannot overwrite the stored draft with less data.
  try {
    const session = await getSession();
    if (!session?.user?.id) return unauthorized();

    const draft = await prisma.onboardingDraft.findUnique({
      where: { userId: session.user.id },
      select: { role: true, currentStep: true, payload: true, version: true },
    });

    if (!draft) return { success: true, draft: null };

    // A quarantined payload also invalidates the step: resuming at step 4 of a
    // form whose answers were just discarded drops the user into a blank
    // later step with no way to see what they are missing.
    const { payload, reason } = readStoredDraftPayload(draft.payload);
    const snapshot: OnboardingDraftSnapshot = {
      role: draft.role,
      currentStep: reason === null ? draft.currentStep : 0,
      payload,
      version: draft.version,
      quarantined: reason !== null,
    };
    return { success: true, draft: snapshot };
  } catch {
    return { success: false, error: "Draft unavailable" };
  }
}

/** Idempotent by design — called after successful completion and whenever the
 *  wizard restarts from step 0 with no meaningful state to keep. */
export async function clearOnboardingDraftAction(): Promise<DraftActionResult> {
  const session = await getSession();
  if (!session?.user?.id) return unauthorized();

  await prisma.onboardingDraft.deleteMany({
    where: { userId: session.user.id },
  });

  return { success: true };
}
