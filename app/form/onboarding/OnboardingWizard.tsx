"use client";

import {
  addConsultantIdentityAction,
  updateOnboardingInformationAction,
  loadIdentitySeedAction,
} from "@/actions/forms/onboarding.action";
import {
  clearOnboardingDraftAction,
  loadOnboardingDraftAction,
  saveOnboardingDraftAction,
} from "@/actions/onboarding-draft.action";
import {
  createDraftSaveQueue,
  encodeDraftForSaveDetailed,
  type DraftSaveQueue,
} from "@/utils/onboarding-draft";
import { trackOnboardingEvent } from "@/utils/onboarding-telemetry";
import {
  OnboardingFormData,
  OnboardingFormDataSchema,
  transformOnboardingFormToServerData,
  transformOrgOnboardingForm,
} from "@/utils/onboarding";
import { History, LogOut, RotateCcw } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import * as Sentry from "@sentry/nextjs";
import { stepEnter, stepExit, stepTransition, stepVisible } from "@/lib/motion";
import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { OnboardingStepper } from "@/components/onboarding/onboarding-stepper";
import { OnboardingNotice } from "@/components/onboarding/OnboardingNotice";
import { useToast } from "@/hooks/use-toast";
import { useSession } from "@/lib/auth-client";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import {
  describeIssuePath,
  stepKeyForField,
  summarizeIssues,
  type OnboardingStepKey,
} from "./field-map";
import {
  getPendingReferral,
  clearPendingReferral,
} from "@/lib/pending-referral";
import { safeSameOriginPath } from "@/lib/navigation/safe-path";
import { useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
// Step 0 stays eager — every user sees Personal Info first.
import PersonalInfoAndRoleForm from "./components/PersonalInfoAndRoleForm";

// Later steps + org wizard are code-split so the initial onboarding chunk
// does not pay for schedule UI, review forms, or the create-org wizard.
//
// Every split step needs `loading` — next/dynamic renders null while the chunk
// downloads, so without it pressing Next collapses the card to zero height and
// reads as a frozen app on a slow connection. The options object is repeated
// inline rather than hoisted to a shared const because SWC statically analyses
// it: a variable fails the build with "next/dynamic options must be an object
// literal".
function StepLoading() {
  return (
    <div className="flex items-center justify-center min-h-[240px]">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
      <span className="sr-only">Loading this step…</span>
    </div>
  );
}

const ConsultantPreferredScheduleForm = dynamic(
  () => import("./components/ConsultantPreferredScheduleForm"),
  { ssr: false, loading: () => <StepLoading /> },
);
const ConsultantProfessionalStep = dynamic(
  () => import("./components/ConsultantProfessionalStep"),
  { ssr: false, loading: () => <StepLoading /> },
);
const ConsultantAgreementAndVerificationStep = dynamic(
  () => import("./components/ConsultantAgreementAndVerificationStep"),
  { ssr: false, loading: () => <StepLoading /> },
);
const ConsultantReviewForm = dynamic(
  () => import("./components/ConsultantReviewForm"),
  { ssr: false, loading: () => <StepLoading /> },
);
const ConsulteeAgreementForm = dynamic(
  () => import("./components/ConsulteeAgreementForm"),
  { ssr: false, loading: () => <StepLoading /> },
);
const CreateOrganizationWizard = dynamic(
  () =>
    import("@/components/organization/create-wizard/Wizard").then((m) => ({
      default: m.CreateOrganizationWizard,
    })),
  { ssr: false, loading: () => <StepLoading /> },
);

// ---------------------------------------------------------------------------
// Step registry
// ---------------------------------------------------------------------------

/**
 * Everything a step can need from the shell. The step forms were written
 * independently and take different props (`onNext`/`initialData` vs
 * `onSubmit`/`formData`/`onGoToStep`), so each entry adapts this context to its
 * own component instead of a single prop contract being forced on all of them.
 */
interface OnboardingStepContext {
  formData: Partial<OnboardingFormData>;
  userId?: string;
  /** Add mode: an onboarded account adding a consultant identity (PR-6). */
  addIdentity?: boolean;
  onNext: (data: Partial<OnboardingFormData>) => Promise<void>;
  onBack: () => void;
  onSubmit: (data: Partial<OnboardingFormData>) => Promise<void>;
  /** Returns whether the jump was taken, so a caller only clears its own
   *  affordance when the wizard actually moved. */
  onGoToStep: (targetStep: number) => boolean;
  onExitOrgWizard: () => void;
  /** Settle in-flight draft saves before anything deletes the row. */
  onQuiesceDraftSaves: () => Promise<void>;
  /** Field-level autosave for the long steps; merged over `formData`. */
  onDraftChange: (partial: Record<string, unknown>) => void;
  /** A final submit is in flight. */
  isSubmitting: boolean;
}

interface OnboardingStep {
  /** Which payload fields the step owns (see field-map.ts). */
  key: OnboardingStepKey;
  /** Shown in the progress stepper and as the card title. */
  label: string;
  render: (ctx: OnboardingStepContext) => React.ReactNode;
  /** Needs more horizontal room than the default 3xl card. */
  wide?: boolean;
  /**
   * Step paints its own full-page chrome, so the shell (header, stepper, card)
   * steps aside entirely rather than nesting one stepper inside another.
   */
  fullBleed?: boolean;
}

// Roles come from the onboarding schema's discriminated union rather than a
// hand-written list, so adding a branch there fails to compile here until it
// declares its steps.
type OnboardingRole = z.infer<typeof OnboardingFormDataSchema>["role"];

// Shared across every role: step 0 is where the role is picked, so it cannot be
// role-specific.
const personalInfoStep: OnboardingStep = {
  key: "personal",
  label: "Personal Info",
  render: (ctx) => (
    <PersonalInfoAndRoleForm
      onNext={ctx.onNext}
      initialData={ctx.formData}
      lockedRole={ctx.addIdentity ? "CONSULTANT" : undefined}
    />
  ),
};

/**
 * The onboarding flow, per role. Order in the array IS the step order — indices
 * are never written down anywhere, which is what lets ORG_WORKSPACE be a normal
 * two-entry flow instead of a special case bolted onto the step machine.
 *
 * CONSULTEE is deliberately two screens (#onboarding-ux): demand-side users
 * reach marketplace value with one form + consent. Profile enrichment
 * (career stage, goals, about-me) is deferred to the consultee dashboard's
 * Settings tab and the lazy `ensureConsulteeProfile` path — the server payload
 * schema already treats every consultee profile field as optional.
 */
const ONBOARDING_STEPS: Record<OnboardingRole, OnboardingStep[]> = {
  CONSULTANT: [
    personalInfoStep,
    {
      key: "professional",
      label: "Professional Profile",
      render: (ctx) => (
        <ConsultantProfessionalStep
          onNext={ctx.onNext}
          onBack={ctx.onBack}
          onDraftChange={ctx.onDraftChange}
          initialData={ctx.formData}
          personalInfo={{
            name: ctx.formData.name ?? "",
            email: ctx.formData.email ?? "",
            phone: ctx.formData.phone,
            address: ctx.formData.address,
            onlineStatus: ctx.formData.onlineStatus ?? false,
            timezone: ctx.formData.timezone,
            onboardingCompleted: ctx.formData.onboardingCompleted ?? false,
            role: ctx.formData.role ?? "CONSULTANT",
            // #1132 — step 1 cannot be completed without a validated adult DOB,
            // so by the time this step renders the value is always present. The
            // fallback keeps the type honest without inventing an age.
            dateOfBirth: ctx.formData.dateOfBirth ?? new Date(0),
            emailVerified: ctx.formData.emailVerified,
            image: ctx.formData.image,
          }}
        />
      ),
    },
    {
      key: "availability",
      label: "Availability",
      // The weekly slot grid does not fit the default card width.
      wide: true,
      render: (ctx) => (
        <ConsultantPreferredScheduleForm
          onNext={ctx.onNext}
          onBack={ctx.onBack}
          initialData={ctx.formData}
        />
      ),
    },
    {
      key: "agreement",
      label: "Agreement & Verification",
      render: (ctx) => (
        <ConsultantAgreementAndVerificationStep
          onNext={ctx.onNext}
          onBack={ctx.onBack}
          onDraftChange={ctx.onDraftChange}
          formData={ctx.formData}
        />
      ),
    },
    {
      key: "review",
      label: "Review",
      render: (ctx) => (
        <ConsultantReviewForm
          onSubmit={ctx.onSubmit}
          onBack={ctx.onBack}
          formData={ctx.formData}
          onGoToStep={ctx.onGoToStep}
        />
      ),
    },
  ],
  CONSULTEE: [
    personalInfoStep,
    {
      key: "agreement",
      label: "Agreement",
      render: (ctx) => (
        <ConsulteeAgreementForm
          onNext={(data) => ctx.onSubmit(data)}
          onBack={ctx.onBack}
          formData={ctx.formData}
          isSubmitting={ctx.isSubmitting}
        />
      ),
    },
  ],
  ORG_WORKSPACE: [
    personalInfoStep,
    {
      key: "agreement",
      label: "Agreement",
      render: (ctx) => (
        <ConsulteeAgreementForm
          onNext={ctx.onNext}
          onBack={ctx.onBack}
          formData={ctx.formData}
        />
      ),
    },
    {
      key: "org",
      // The shared wizard owns several more screens with its own stepper, so
      // this entry names the phase rather than claiming to be the last screen.
      label: "Organisation setup",
      fullBleed: true,
      render: (ctx) => (
        // hostOrgsEnabled stays false (host capability hidden) while
        // ENABLE_HOST_ORGS is off; this client wizard has no server flag read.
        <CreateOrganizationWizard
          onCancel={ctx.onExitOrgWizard}
          // Org, role, profile, onboarding and consent commit in one tx.
          onboarding={transformOrgOnboardingForm(ctx.formData)}
          afterLaunch={async () => {
            // No save may land after the draft row is deleted below.
            await ctx.onQuiesceDraftSaves();
            await clearOnboardingDraftAction().catch(() => {});
          }}
        />
      ),
    },
  ],
};

/**
 * Pick the step registry for a role, defaulting to the consultee flow.
 *
 * `Object.hasOwn` rather than `role in ONBOARDING_STEPS`: `in` walks the
 * prototype chain, so "constructor", "toString" and "__proto__" all answer
 * true and yield an Object.prototype member instead of a step array — and the
 * resulting `steps.map(...)` throws during render, taking the "Start over"
 * button down with it.
 *
 * Kept as defence in depth now that the draft payload has a structural schema
 * (`OnboardingDraftPayloadSchema`). That schema strips poisoned KEYS at the
 * storage boundary, but `role` is a legitimate key whose VALUE stays
 * deliberately untyped — a draft holds answers that are not yet valid — so
 * `role: "__proto__"` remains expressible and this guard remains the thing
 * that stops it. It also covers the value arriving from anywhere but a draft.
 */
function resolveRegistryRole(role: unknown): OnboardingRole {
  return typeof role === "string" && Object.hasOwn(ONBOARDING_STEPS, role)
    ? (role as OnboardingRole)
    : "CONSULTEE";
}

/** Debounce for step-transition saves (coalesces rapid Next/Back clicks). */
const DRAFT_SAVE_DEBOUNCE_MS = 800;
/** Debounce for field-level saves on the long consultant steps. */
const FIELD_AUTOSAVE_DEBOUNCE_MS = 2000;
/** One retry before giving up on loading the draft for this visit. */
const DRAFT_LOAD_RETRY_MS = 1500;

/**
 * Payload key → the words the user sees on the form. Only the fields that can
 * realistically dominate a 64KB payload are listed; anything else falls back
 * to generic wording rather than leaking an internal key name into the UI.
 */
const DRAFT_FIELD_LABELS: Record<string, string> = {
  aboutMe: "“About me” summary",
  achievements: "achievements",
  bio: "short bio",
  certificationsList: "certifications",
  customSlots: "custom availability",
  description: "expertise summary",
  educationHistory: "education entries",
  mentoringStyle: "mentoring style",
  qualifications: "qualifications",
  specialization: "specialization",
  verificationDocuments: "verification documents",
  verificationNotes: "verification notes",
  weeklySlots: "weekly availability",
  workExperiences: "work experience entries",
};

/** `Object.hasOwn` for the same reason as `resolveRegistryRole`: the key comes
 *  from a stored payload, and `in` would happily resolve "toString". */
function describeDraftField(field: string | null): string {
  return field && Object.hasOwn(DRAFT_FIELD_LABELS, field)
    ? DRAFT_FIELD_LABELS[field]
    : "longest answers";
}

/**
 * Dead-session recovery: sign out, then return to sign-in preserving the
 * wizard destination. Success navigates straight there; a failed sign-out may
 * leave a valid cookie behind, so the error path goes through the stale-session
 * cleanup endpoint first (fail closed) — otherwise sign-in would bounce
 * straight back to the wizard on the live cookie.
 *
 * Ordinary recovery (`?callbackUrl=/checkout/…`) passes the validated ORIGINAL
 * callback through — wrapping the whole onboarding URL would nest it, and after
 * completion the guard would see a fully-onboarded user on the wizard (without
 * add mode) and drop them on the dashboard, never reaching checkout. Add mode
 * (`?add=CONSULTANT`) keeps the full wizard URL, which requireNotOnboarded
 * admits for eligible users.
 */
function signOutToSignin() {
  const search = typeof window !== "undefined" ? window.location.search : "";
  const params = new URLSearchParams(search);
  const inner = safeSameOriginPath(params.get("callbackUrl"));
  const here =
    inner && params.get("add") !== "CONSULTANT"
      ? inner
      : `/form/onboarding${search ? `?${params.toString()}` : ""}`;
  const signinHref = `/auth/signin?callbackUrl=${encodeURIComponent(here)}`;
  void signOutEverywhere(signinHref);
}

interface OnboardingWizardProps {
  /** Add mode: an onboarded learner / org operator adding a consultant
   *  identity. Computed by the server page from the live session. */
  addIdentity: boolean;
  /** The guard sent an onboarded user whose role profile is missing. */
  missingProfile: boolean;
}

export function OnboardingWizard({
  addIdentity,
  missingProfile,
}: Readonly<OnboardingWizardProps>) {
  const { data: session } = useSession();
  const [step, setStep] = useState(0);
  // Which way the user last travelled, so the step transition can slide in the
  // matching direction. `1` = forward (new step rises from below), `-1` = back.
  const [direction, setDirection] = useState<1 | -1>(1);
  const [formData, setFormData] = useState<Partial<OnboardingFormData>>({});
  const [draftRestored, setDraftRestored] = useState(false);
  // The step a saved draft points at when the user had already started
  // typing before it loaded: offered as a button instead of jumped to.
  const [resumeStep, setResumeStep] = useState<number | null>(null);
  // Set by the first pointer or key event inside the wizard before hydration
  // resolved; read once, when the draft lands.
  const interactedRef = useRef(false);
  // The stored draft existed but could not be restored (wizard version bump or
  // a corrupt row). Silence here reads as data loss, so it gets its own banner.
  const [draftQuarantined, setDraftQuarantined] = useState(false);
  // Autosave has stopped because the payload outgrew the column budget. Sticky
  // by nature — every later save fails the same way until something shrinks.
  const [draftOverBudgetField, setDraftOverBudgetField] = useState<
    string | null
  >(null);
  const [draftOverBudget, setDraftOverBudget] = useState(false);
  // The draft could not be loaded, so autosave stays off for this visit.
  const [draftUnavailable, setDraftUnavailable] = useState(false);
  // Another tab or device saved a newer draft; this tab stopped saving.
  const [draftConflict, setDraftConflict] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const router = useRouter();
  const { toast } = useToast();

  // Refs gate side effects across renders without re-triggering them:
  //  - draftReadyRef: autosave arms only after a successful load, so a
  //    failed or empty mount-time state never overwrites the stored draft.
  //  - draftCompletedRef: once onboarding succeeds (or the user starts over),
  //    stop saving; the row is being deleted server-side.
  const draftReadyRef = useRef(false);
  const draftCompletedRef = useRef(false);
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // CAS base for the next save; read when the queued save runs.
  const draftVersionRef = useRef(0);
  const draftConflictRef = useRef(false);
  // Unsubmitted edits inside the current long step (field-level autosave).
  const stepOverlayRef = useRef<Record<string, unknown>>({});
  // Latest step/state for the pagehide flush and the hydrate merge; synced by
  // the effect below, which is declared before every effect that reads them.
  const stepRef = useRef(0);
  const formDataRef = useRef<Partial<OnboardingFormData>>({});
  // Serialized saves: each reads the version the previous one returned, and
  // the row is never deleted while a save is still unsettled.
  const draftSaveQueueRef = useRef<DraftSaveQueue>(createDraftSaveQueue());
  // True while a step transition is in flight. Guards `handleNext` against a
  // second click on the still-mounted outgoing form; released by
  // AnimatePresence's onExitComplete, or explicitly on an error path that does
  // not change the step.
  const transitioningRef = useRef(false);
  const submittingRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusOnStepChangeRef = useRef(false);

  useEffect(() => {
    stepRef.current = step;
    formDataRef.current = formData;
  }, [step, formData]);

  // Apply a referral code captured at first touch (signup / r/[code]) now that
  // the user is authenticated. Idempotent server-side; the code is kept until
  // a definitive outcome (success or a terminal 400) so transient failures retry.
  useEffect(() => {
    if (!session?.user?.id) return;
    const code = getPendingReferral();
    if (!code) return;
    fetch("/api/referrals/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    })
      .then((res) => {
        if (res.ok || res.status === 400) clearPendingReferral();
      })
      .catch(() => {});
  }, [session?.user?.id]);

  // Hydrate the resumable draft once per mount. Runs after the guard has
  // confirmed this user still needs onboarding (or is in add mode).
  useEffect(() => {
    let cancelled = false;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    async function loadDraft() {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt > 0) await sleep(DRAFT_LOAD_RETRY_MS);
        if (cancelled) return null;
        try {
          const result = await loadOnboardingDraftAction();
          if (result.success) return result;
        } catch {
          // Retried once below; then autosave stays off for this visit.
        }
      }
      return null;
    }
    async function hydrate() {
      if (addIdentity) {
        // Pre-fill step 0 from the account; a draft (below) may still layer
        // over it when the user left mid-way.
        try {
          const seeded = await loadIdentitySeedAction();
          if (!cancelled && seeded.success) {
            const seed = {
              ...seeded.seed,
              role: "CONSULTANT",
            } as Partial<OnboardingFormData>;
            formDataRef.current = { ...seed, ...formDataRef.current };
            setFormData((prev) => ({ ...seed, ...prev }));
          }
        } catch {
          // The form still renders; the user retypes what did not load.
        }
      }
      const result = await loadDraft();
      if (cancelled) return;
      if (!result) {
        // Autosave stays off: saving now would overwrite a draft we never saw.
        setDraftUnavailable(true);
        trackOnboardingEvent("draft_load_failed", { reason: "unavailable" });
        return;
      }
      draftVersionRef.current = result.draft?.version ?? 0;
      draftReadyRef.current = true;
      if (!result.draft) return;
      const { payload, currentStep, role, quarantined } = result.draft;
      // A quarantined draft is the one case where "nothing restored" is not
      // the same as "nothing was ever saved". Say so: the user typed those
      // answers and is entitled to know they are not coming back.
      if (quarantined) {
        setDraftQuarantined(true);
        trackOnboardingEvent("draft_quarantined", { currentStep, role });
        return;
      }
      const hasPayload = Object.keys(payload).length > 0;
      if (!hasPayload && !(role && currentStep > 0)) return;
      // Whatever the user already committed (a step-0 submit that beat this
      // load) outranks the stored draft; the ref holds the latest committed
      // state, and the effective role is needed now to clamp the step.
      const merged = {
        ...payload,
        ...formDataRef.current,
      } as Partial<OnboardingFormData>;
      setFormData(merged);
      // Clamp against the registry the render will select (it reads
      // formData.role, i.e. the merged payload, not the stored column).
      const effectiveRole = resolveRegistryRole(merged.role);
      const registry = ONBOARDING_STEPS[effectiveRole];
      if (currentStep > 0) {
        const target = Math.max(0, Math.min(currentStep, registry.length - 1));
        // Someone already typing on step 0 keeps their place; the banner
        // offers the stored step instead of yanking the form away.
        if (interactedRef.current) setResumeStep(target);
        // The draft can only move the wizard forward from step 0, which is
        // where this effect runs, so the direction is always forward.
        if (target > 0) {
          setDirection(1);
          setStep(target);
        }
      }
      if (currentStep > 0 || hasPayload) setDraftRestored(true);
      trackOnboardingEvent("draft_restored", { currentStep, role });
    }
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [addIdentity]);

  // The one place a draft snapshot is dispatched. Shared by the debounce
  // timers and the pagehide flush so all go through the same gate and queue.
  const dispatchDraftSave = useCallback(
    (snapshotStep: number, snapshot: Record<string, unknown>) => {
      if (draftConflictRef.current) return;
      const prepared = encodeDraftForSaveDetailed({
        role:
          typeof snapshot.role === "string"
            ? resolveRegistryRole(snapshot.role)
            : null,
        currentStep: snapshotStep,
        payload: snapshot,
        baseVersion: draftVersionRef.current,
      });
      // OVER_BUDGET is sticky: every later save is a no-op until the payload
      // shrinks, so the banner below names the field to trim.
      if (!prepared.ok) {
        trackOnboardingEvent("draft_save_skipped", {
          reason: prepared.reason,
          bytes: prepared.bytes ?? null,
          currentStep: snapshotStep,
        });
        if (prepared.reason === "OVER_BUDGET") {
          setDraftOverBudgetField(prepared.largestField ?? null);
          setDraftOverBudget(true);
        }
        return;
      }
      // Back under budget — the user trimmed something, so stop warning.
      setDraftOverBudget(false);
      const encoded = prepared.value;
      void draftSaveQueueRef.current
        .enqueue(async () => {
          if (draftConflictRef.current || draftCompletedRef.current) return;
          const result = await saveOnboardingDraftAction({
            ...encoded,
            baseVersion: draftVersionRef.current,
          });
          if (result.success) {
            draftVersionRef.current = result.version;
          } else if (result.code === "DRAFT_CONFLICT") {
            draftConflictRef.current = true;
            draftVersionRef.current =
              result.currentVersion ?? draftVersionRef.current;
            setDraftConflict(true);
            trackOnboardingEvent("draft_conflict", {
              currentStep: snapshotStep,
            });
          } else {
            trackOnboardingEvent("draft_save_failed", {
              error: result.code ?? "refused",
            });
          }
        })
        .catch(() => {
          trackOnboardingEvent("draft_save_failed", { error: "unreachable" });
        });
    },
    [],
  );

  const scheduleDraftSave = useCallback(
    (delayMs: number) => {
      if (!draftReadyRef.current || draftCompletedRef.current) return;
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = setTimeout(() => {
        draftSaveTimerRef.current = null;
        dispatchDraftSave(stepRef.current, {
          ...formDataRef.current,
          ...stepOverlayRef.current,
        });
      }, delayMs);
    },
    [dispatchDraftSave],
  );

  // A step change commits that step's edits into formData; the overlay only
  // ever describes the step on screen.
  useEffect(() => {
    stepOverlayRef.current = {};
  }, [step]);

  // Autosave: debounce every step/data transition into a single save.
  useEffect(() => {
    if (!session?.user?.id) return;
    scheduleDraftSave(DRAFT_SAVE_DEBOUNCE_MS);
  }, [step, formData, session?.user?.id, scheduleDraftSave]);

  useEffect(() => {
    return () => {
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    };
  }, []);

  const handleDraftChange = useCallback(
    (partial: Record<string, unknown>) => {
      stepOverlayRef.current = { ...stepOverlayRef.current, ...partial };
      scheduleDraftSave(FIELD_AUTOSAVE_DEBOUNCE_MS);
    },
    [scheduleDraftSave],
  );

  // Flush a pending save when the page is hidden or torn down. `pagehide`
  // (not `beforeunload`) because bfcache and iOS Safari only fire the former;
  // `visibilitychange` catches tab switches and app backgrounding.
  useEffect(() => {
    if (!session?.user?.id) return;
    const flush = () => {
      if (!draftReadyRef.current || draftCompletedRef.current) return;
      if (!draftSaveTimerRef.current) return; // nothing pending
      clearTimeout(draftSaveTimerRef.current);
      draftSaveTimerRef.current = null;
      dispatchDraftSave(stepRef.current, {
        ...formDataRef.current,
        ...stepOverlayRef.current,
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [session?.user?.id, dispatchDraftSave]);

  // Move focus to the new step's heading so screen readers announce it.
  useEffect(() => {
    if (!focusOnStepChangeRef.current) {
      focusOnStepChangeRef.current = true;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  /** Cancel pending autosave and let every dispatched-but-unsettled save land
   *  BEFORE the caller deletes the draft row. */
  const quiesceDraftSaves = async () => {
    draftCompletedRef.current = true;
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    await draftSaveQueueRef.current.drain().catch(() => {});
  };

  // Only the window before the draft lands matters; afterwards the flag is
  // never read again, so the handler is a no-op once hydration resolved.
  const markInteracted = useCallback(() => {
    if (!draftReadyRef.current) interactedRef.current = true;
  }, []);

  const startOver = async () => {
    await quiesceDraftSaves();
    setDraftRestored(false);
    setResumeStep(null);
    // Both warnings describe the draft being discarded here, so neither can
    // outlive it.
    setDraftQuarantined(false);
    setDraftOverBudget(false);
    setFormData({});
    // Always a backward jump to step 0, so the card must animate backwards.
    setDirection(-1);
    setStep(0);
    await clearOnboardingDraftAction().catch(() => {});
    // The row is gone, so the next save creates it from version 0.
    draftVersionRef.current = 0;
    draftCompletedRef.current = false;
  };

  /** Keep this tab's answers: overwrite the newer draft from here on. */
  const keepThisTabsDraft = () => {
    draftConflictRef.current = false;
    setDraftConflict(false);
    dispatchDraftSave(stepRef.current, {
      ...formDataRef.current,
      ...stepOverlayRef.current,
    });
  };

  const handleSignOut = async () => {
    await quiesceDraftSaves();
    void signOutEverywhere("/");
  };

  const handleNext = async (stepData: Partial<OnboardingFormData>) => {
    // A step transition holds the outgoing form on screen (AnimatePresence
    // mode="wait") with its Continue button still live. A second click in
    // that window would run this again against the ALREADY-incremented `step`
    // and skip the next step's validation.
    if (transitioningRef.current) return;
    transitioningRef.current = true;
    // The guard is released by onExitComplete, which only runs if the step
    // actually changes; every other exit releases it in the finally below.
    let advanced = false;
    try {
      const merged: Partial<OnboardingFormData> = {
        ...formData,
        ...stepData,
      };
      if (stepData.scheduleType) {
        merged.scheduleType = stepData.scheduleType;
        if (stepData.weeklySlots) {
          merged.weeklySlots = [...stepData.weeklySlots];
        }
        if (stepData.customSlots) {
          merged.customSlots = [...stepData.customSlots];
        }
      }
      setFormData(merged);
      setDirection(1);
      trackOnboardingEvent("step_advance", {
        fromStep: step,
        role: merged.role ?? null,
      });
      setStep((prevStep) => prevStep + 1);
      advanced = true;
    } finally {
      if (!advanced) transitioningRef.current = false;
    }
  };

  // Back and the stepper share `handleNext`'s guard: the outgoing step's own
  // Back button is live during the exit too, and an unguarded decrement would
  // walk the user back past the step they just left.
  const handleBack = () => {
    if (transitioningRef.current) return;
    // A no-op move changes no key, so onExitComplete would never fire and the
    // guard would stay set — freezing the wizard. Bail before arming it.
    if (step <= 0) return;
    transitioningRef.current = true;
    trackOnboardingEvent("step_back", { fromStep: step });
    setDirection(-1);
    setStep((prevStep) => prevStep - 1);
  };

  // Returns whether the jump was taken. The resume banner clears its stored
  // step only on a true: if a transition is already in flight the guard
  // rejects the jump, and clearing unconditionally would destroy the shortcut
  // without moving the user anywhere.
  const handleGoToStep = (targetStep: number): boolean => {
    if (transitioningRef.current) return false;
    if (targetStep === step) return false;
    transitioningRef.current = true;
    // A stepper jump can be in either direction; derive it rather than
    // defaulting to forward, or "Review → step 2" slides the wrong way.
    setDirection(targetStep >= step ? 1 : -1);
    setStep(targetStep);
    return true;
  };

  // Backing out of the create-org wizard returns to step 0. Nothing was
  // committed server-side: the org path completes only inside the org POST.
  const handleExitOrgWizard = () => {
    // The org step is `fullBleed`, so the shell (and the AnimatePresence that
    // would call onExitComplete) is unmounted; release the guard explicitly.
    transitioningRef.current = false;
    setDirection(-1);
    setStep(0);
  };

  const handleSubmit = async (data: Partial<OnboardingFormData>) => {
    // Every final step shares this guard, so a double click submits once.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    try {
      await submitOnboarding(data);
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  const submitOnboarding = async (data: Partial<OnboardingFormData>) => {
    const finalData = { ...formData, ...data };

    try {
      const id = session?.user?.id;
      if (!id) {
        toast({
          title: "Session Expired",
          description: "Please sign in again to continue.",
          variant: "destructive",
        });
        signOutToSignin();
        return;
      }

      const validationResult = OnboardingFormDataSchema.safeParse(finalData);
      if (!validationResult.success) {
        const errors = validationResult.error.errors;
        // Name the fields in the customer's words and send them to the step
        // that owns the first one; the review step cannot fix anything itself.
        const groups = summarizeIssues(
          errors,
          steps.map((s) => s.key),
        );
        const first = groups[0];
        const targetStep = first?.stepKey
          ? steps.findIndex((s) => s.key === first.stepKey)
          : -1;
        toast({
          title: "A few answers need attention",
          description: groups
            .flatMap((g) => g.lines)
            .slice(0, 4)
            .join(" · "),
          variant: "destructive",
        });
        if (targetStep >= 0 && targetStep !== step) {
          setDirection(targetStep > step ? 1 : -1);
          setStep(targetStep);
        }
        // Step keys only — never field values or paths.
        trackOnboardingEvent("submit_validation_failed", {
          groups: groups.length,
          steps: groups
            .map((g) => g.stepKey)
            .filter((k) => k !== null)
            .join(","),
          role: finalData.role ?? null,
        });
        return;
      }

      // The discriminated-union output satisfies the flat intersection type
      // at runtime (one branch is fully populated); TS cannot prove it.
      const validated = validationResult.data as OnboardingFormData;
      const requestBody = {
        ...transformOnboardingFormToServerData(validated),
        workExperiences: validated.workExperiences,
        educationHistory: validated.educationHistory,
        certificationsList: validated.certificationsList,
        achievements: validated.achievements,
      };

      toast({
        title: "Saving Your Profile",
        description: "Please wait while we set up your account...",
      });

      const result = addIdentity
        ? await addConsultantIdentityAction(id, requestBody)
        : await updateOnboardingInformationAction(id, requestBody);

      if (!result.success || !result.user) {
        const errorMessage =
          result.error ?? "Failed to save your profile. Please try again.";

        if (result.code === "USER_NOT_FOUND") {
          toast({
            title: "Account Not Found",
            description: "Your session has expired. Please sign in again.",
            variant: "destructive",
          });
          signOutToSignin();
          return;
        }

        trackOnboardingEvent("submit_error", {
          error: result.code ?? "refused",
        });
        // A typed refusal names the field it is about; the step that owns it
        // is where the fix happens, so go there with the sentence.
        const refusedStep = result.field
          ? steps.findIndex((s) => s.key === stepKeyForField(result.field!))
          : -1;
        toast({
          title: result.field
            ? `${describeIssuePath(
                result.index === undefined
                  ? [result.field]
                  : [result.field, result.index],
              )} needs a change`
            : "Unable to Save Profile",
          description: errorMessage,
          variant: "destructive",
        });
        if (refusedStep >= 0 && refusedStep !== step) {
          setDirection(refusedStep > step ? 1 : -1);
          setStep(refusedStep);
        }
        return;
      }

      // Success: stop autosaving, drain in-flight saves, then drop the draft
      // (awaited, so the redirect below cannot race the delete).
      await quiesceDraftSaves();
      await clearOnboardingDraftAction().catch(() => {});

      if (result.verificationWarning) {
        toast({
          title: "Profile Saved — Verification Issue",
          description: result.verificationWarning,
          variant: "destructive",
        });
      } else if (
        finalData.role === "CONSULTANT" &&
        result.verificationDeferred
      ) {
        trackOnboardingEvent("verification_deferred", {});
        toast({
          title: "Profile Submitted!",
          description:
            "Add your LinkedIn URL and one document from Settings to get verified — your profile is saved and you can explore the dashboard meanwhile.",
        });
      } else if (finalData.role === "CONSULTANT") {
        toast({
          title: "Profile Submitted!",
          description:
            "Your verification is under review (1-2 business days). You can start setting up your consultation plans while you wait.",
        });
      } else {
        toast({
          title: "Welcome to Familiarise!",
          description:
            "Your profile is ready. Browse our expert directory to book your first session.",
        });
      }

      trackOnboardingEvent("submit_success", {
        role: finalData.role ?? null,
        verificationDeferred: Boolean(result.verificationDeferred),
      });

      // An explicit callbackUrl outranks the stashed invite token, which is
      // consumed either way so a stale one never hijacks a later onboarding.
      const callbackUrlParam = new URLSearchParams(window.location.search).get(
        "callbackUrl",
      );
      const safeCallback = safeSameOriginPath(callbackUrlParam);

      let pendingToken: string | null = null;
      try {
        pendingToken = localStorage.getItem("pendingOrgInviteToken");
        if (pendingToken) localStorage.removeItem("pendingOrgInviteToken");
      } catch {
        // Storage unavailable (e.g. private mode): nothing to resume.
      }

      // Terminal navigation: replace, never push, so Back from the
      // destination does not bounce through the wizard again.
      if (safeCallback) {
        router.replace(safeCallback);
        return;
      }
      if (pendingToken && /^[A-Za-z0-9_-]+$/.test(pendingToken)) {
        router.replace(`/organizations/invite/${pendingToken}`);
        return;
      }
      if (finalData.role === "CONSULTANT" && result.user.consultantProfileId) {
        router.replace(
          `/dashboard/consultant/${String(result.user.consultantProfileId)}`,
        );
      } else if (
        finalData.role === "CONSULTEE" &&
        result.user.consulteeProfileId
      ) {
        router.replace(
          `/dashboard/consultee/${String(result.user.consulteeProfileId)}`,
        );
      } else {
        router.replace("/dashboard");
      }
    } catch (error: unknown) {
      // A synthetic error carrying only the error NAME: the raw exception can
      // carry submitted field values.
      trackOnboardingEvent("submit_error", { error: "unhandled_exception" });
      Sentry.captureException(
        new Error(
          `onboarding_submit_failed: ${
            error instanceof Error ? error.name : "unknown"
          }`,
        ),
        { tags: { surface: "onboarding", stage: "submit" } },
      );
      toast({
        title: "Something Went Wrong",
        description: "An unexpected error occurred. Please try again.",
        variant: "destructive",
      });
    }
  };

  // `role` is only trustworthy once step 0 has been submitted; before that (and
  // for anything the registry does not cover) the consultee flow is the default.
  const currentRole: OnboardingRole = addIdentity
    ? "CONSULTANT"
    : resolveRegistryRole(formData.role);
  const steps = ONBOARDING_STEPS[currentRole];
  const totalSteps = steps.length;
  const activeStep = steps[step];

  const stepContext: OnboardingStepContext = {
    formData,
    userId: session?.user?.id,
    addIdentity,
    onNext: handleNext,
    onBack: handleBack,
    onSubmit: handleSubmit,
    onGoToStep: handleGoToStep,
    onExitOrgWizard: handleExitOrgWizard,
    onQuiesceDraftSaves: quiesceDraftSaves,
    onDraftChange: handleDraftChange,
    isSubmitting,
  };

  if (activeStep?.fullBleed) {
    return <>{activeStep.render(stepContext)}</>;
  }

  return (
    <OnboardingShell
      wide={activeStep?.wide}
      header={
        <div className="container mx-auto flex items-center justify-between gap-4 px-4 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
              <svg
                className="h-5 w-5 text-primary-foreground"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 10V3L4 14h7v7l9-11h-7z"
                />
              </svg>
            </div>
            <span className="truncate text-xl font-semibold">Familiarise</span>
          </div>
          <div className="flex shrink-0 items-center gap-3 sm:gap-4">
            <span className="text-sm text-muted-foreground sm:hidden">
              {step + 1}/{totalSteps}
            </span>
            <button
              onClick={() => void handleSignOut()}
              className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      }
      stepper={
        <OnboardingStepper
          steps={steps.map((s) => ({ key: s.key, label: s.label }))}
          current={step}
          onGoToStep={handleGoToStep}
        />
      }
      footer={
        <>
          Need help?{" "}
          <Link href="/support" className="text-primary hover:underline">
            Contact support
          </Link>
        </>
      }
    >
      <div
        onPointerDownCapture={markInteracted}
        onKeyDownCapture={markInteracted}
      >
        {missingProfile && (
          <OnboardingNotice tone="warning">
            Your account is set up, but its profile is missing, so we
            couldn&apos;t open your dashboard.{" "}
            <Link href="/support" className="font-medium underline">
              Contact support
            </Link>{" "}
            and we&apos;ll restore it.
          </OnboardingNotice>
        )}

        {draftConflict && (
          <OnboardingNotice tone="warning">
            There are newer edits from another device or tab, so this tab has
            stopped saving.{" "}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="font-medium underline"
            >
              Reload to see them
            </button>{" "}
            or{" "}
            <button
              type="button"
              onClick={keepThisTabsDraft}
              className="font-medium underline"
            >
              keep this tab&apos;s answers
            </button>
            .
          </OnboardingNotice>
        )}

        {draftUnavailable && (
          <OnboardingNotice tone="info">
            We couldn&apos;t load your saved progress, so this visit won&apos;t
            be saved as you go. You can still finish and submit.
          </OnboardingNotice>
        )}

        {/* Resume banner — shown once when a saved draft was restored */}
        {draftRestored && (
          <div className="mb-6 flex items-center justify-between gap-4 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              <History className="h-4 w-4 shrink-0 text-primary" />
              <span className="text-foreground">
                {resumeStep !== null && resumeStep !== step
                  ? `Welcome back — you had reached step ${resumeStep + 1}. Your typing here is kept either way.`
                  : "Welcome back — we saved your progress."}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-4">
              {resumeStep !== null && resumeStep !== step && (
                <button
                  type="button"
                  onClick={() => {
                    // Through the guard, not a bare setStep. The step-0 form
                    // stays mounted and live for the whole exit animation, so
                    // a bare jump could be followed by an Enter keypress or a
                    // click on the still-present Continue — and handleNext
                    // would then advance from the index the user just asked
                    // for, landing them short and skipping a step's validation.
                    if (handleGoToStep(resumeStep)) setResumeStep(null);
                  }}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  Resume at step {resumeStep + 1}
                </button>
              )}
              <button
                onClick={() => void startOver()}
                className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                title="Discard saved progress and start from the beginning"
              >
                <RotateCcw className="w-4 h-4" />
                Start over
              </button>
            </div>
          </div>
        )}

        {/* Draft could not be restored — the stored answers are gone, and
            saying nothing would read as the wizard losing them silently.
            Tone classes come from the `warning` token rather than raw amber,
            so the banner follows the theme instead of being hard-coded. */}
        {draftQuarantined && (
          <OnboardingNotice tone="warning">
            This form has changed since you last saved, so we couldn&apos;t
            restore your earlier answers. You may need to enter some of them
            again — everything from here on is being saved as normal.
          </OnboardingNotice>
        )}

        {/* Autosave has stopped because the draft outgrew its storage budget.
            Deliberately non-blocking: the submit path has its own, larger
            limits, so the run can still be finished — only RESUMING it later
            is at risk. */}
        {draftOverBudget && (
          <OnboardingNotice tone="warning">
            Your answers are too long for us to save your progress, so this run
            won&apos;t be here if you come back later. Shortening your{" "}
            <strong className="font-medium">
              {describeDraftField(draftOverBudgetField)}
            </strong>{" "}
            will start it saving again. You can still finish and submit without
            changing anything.
          </OnboardingNotice>
        )}

        {/* Form Card */}
        <Card className="shadow-elevation-2">
          <CardHeader className="pb-2 text-center">
            <CardTitle
              ref={headingRef}
              tabIndex={-1}
              className="text-fluid-2xl tracking-tight outline-none"
            >
              {step === 0 ? "Welcome! Let's get started" : activeStep?.label}
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {step === 0
                ? "Tell us a bit about yourself. You can always update this later."
                : "Complete the information below to continue."}
            </p>
          </CardHeader>
          <CardContent className="pt-6">
            {/* `mode="wait"` so the outgoing step finishes before the next
                mounts — without it the two overlap mid-fade and the card
                appears to double.

                `custom={direction}` is load-bearing. The EXITING element has
                already rendered with the previous direction, so reading
                `direction` from the closure would animate Back with the
                direction from the last forward move. Passing it through
                `custom` hands the exiting step the NEW direction, and the
                variant functions below receive it as their argument.

                `onExitComplete` releases the advance guard. The guard — not a
                CSS pointer-events trick — is what stops the outgoing form being
                driven, because it is still on screen and still live for the
                whole exit. A nested `pointer-events-auto` to re-enable the
                current step would re-enable the exiting one too, since in
                `mode="wait"` only the outgoing step is mounted at that point.
            */}
            <AnimatePresence
              mode="wait"
              custom={direction}
              onExitComplete={() => {
                transitioningRef.current = false;
              }}
            >
              <motion.div
                key={activeStep?.key ?? step}
                custom={direction}
                initial="hidden"
                animate="visible"
                exit="exit"
                variants={{
                  hidden: (d: 1 | -1) => stepEnter(d),
                  visible: stepVisible,
                  exit: (d: 1 | -1) => stepExit(d),
                }}
                transition={stepTransition}
              >
                {activeStep?.render(stepContext)}
              </motion.div>
            </AnimatePresence>
          </CardContent>
        </Card>
      </div>
    </OnboardingShell>
  );
}
