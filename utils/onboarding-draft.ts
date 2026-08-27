import { z } from "zod";
import { UserRole } from "@prisma/client";
import { DateOfBirthSchema } from "@/lib/compliance/age";

/**
 * Shared contract for the resumable-onboarding draft row.
 *
 * This module is intentionally free of "server-only" imports so the wizard
 * (client), the draft server actions, and the tests can all speak the same
 * shapes. The Prisma side of the contract lives in prisma/schema.prisma
 * (`OnboardingDraft`) and is never imported here.
 *
 * Two asymmetric problems make a raw round-trip unsafe:
 *
 * 1. WRITE — wizard state contains non-JSON values. `verificationDocuments`
 *    transiently holds `File` instances while an upload is mid-flight, and
 *    functions/undefined sneak in via form-state spreads. The Prisma `Json`
 *    column rejects (or silently mangles) all three, so everything is
 *    sanitized through `sanitizeDraftValue` before persisting.
 *
 * 2. READ — JSON has no Date type. `dateOfBirth` must be a real `Date` by the
 *    time step schemas validate (#1132 age gate) and `OnboardingFormData`
 *    types `emailVerified` as `Date`, yet both come back as ISO strings.
 *    `reviveDraftDates` restores them without trusting the raw strings —
 *    each goes through a Zod schema before becoming a Date.
 */

/** Hard ceiling on the serialized payload. A filled consultant form is ~15KB;
 *  this leaves generous headroom while capping abuse. */
export const ONBOARDING_DRAFT_MAX_BYTES = 64 * 1024;

/** Step indices are bounded by the largest registry (consultant = 5 steps);
 *  the bound exists to catch corrupt clients, not to track the registry. */
export const ONBOARDING_DRAFT_MAX_STEP = 16;

const IsoDateStringSchema = z
  .string()
  .refine(
    (value) => !Number.isNaN(Date.parse(value)),
    "Must be an ISO date string",
  );

/**
 * Accepts a Date or an ISO string and always yields a Date — mirrors how
 * DateOfBirthSchema handles the same ambiguity for the wizard itself.
 */
const RevivableDateSchema = z.union([
  z.date(),
  IsoDateStringSchema.transform((value) => new Date(value)),
]);

const DraftDateFieldsSchema = z
  .object({
    dateOfBirth: RevivableDateSchema.optional(),
    emailVerified: RevivableDateSchema.optional(),
  })
  .partial();

export interface OnboardingDraftSnapshot {
  role: UserRole | null;
  currentStep: number;
  payload: Record<string, unknown>;
}

/** Wire shape of `saveOnboardingDraftAction`'s argument, validated with Zod
 *  because server-action parameters do not survive serialization typed.
 *
 *  Draft roles are narrowed to the PUBLIC flows. STAFF/ADMIN are invite-only
 *  and never render multi-step registries from this wizard; excluding them
 *  keeps the stored role forever incapable of looking like an authorization
 *  signal for a privileged surface. */
const DraftableRoleSchema = z.union([
  z.literal(UserRole.CONSULTANT),
  z.literal(UserRole.CONSULTEE),
  z.literal(UserRole.ORG_WORKSPACE),
]);

export const SaveOnboardingDraftInputSchema = z
  .object({
    role: DraftableRoleSchema.nullable(),
    currentStep: z
      .number()
      .int()
      .min(0)
      .max(ONBOARDING_DRAFT_MAX_STEP),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type SaveOnboardingDraftInput = {
  /** Static type stays the full UserRole enum because the wizard's local
   *  state may transiently hold any role value; the runtime schema narrows
   *  persistence to DraftableRoleSchema (the three public flows). */
  role: UserRole | null;
  currentStep: number;
  payload: Record<string, unknown>;
};

export type DraftActionResult =
  | { success: true }
  | { success: false; error: string };

export type LoadDraftActionResult =
  | { success: true; draft: OnboardingDraftSnapshot | null }
  | { success: false; error: string };

/** Values that must never reach the JSON column, recognized structurally so
 *  the check also works across realm boundaries (e.g. jsdom vs node). Dates
 *  are NOT listed here — they are converted, not dropped. */
function isNonSerializable(value: unknown): boolean {
  return (
    typeof value === "function" ||
    typeof value === "symbol" ||
    value === undefined ||
    (typeof value === "object" &&
      value !== null &&
      ((value.constructor && value.constructor.name === "File") ||
        (value.constructor && value.constructor.name === "Blob") ||
        value instanceof Promise))
  );
}

/**
 * Recursively convert wizard state into JSON-safe data:
 *   File/Blob/function/symbol/undefined/Promise → dropped
 *   Date → ISO string
 *   everything else passes through untouched
 * Depth- and entry-bounded so even a hostile payload terminates quickly; the
 * byte-size check after serialization is the real gate, this just keeps the
 * walk cheap.
 */
export function sanitizeDraftValue(
  value: unknown,
  depth = 0,
): Record<string, unknown> | unknown[] | string | number | boolean | null {
  if (value === null || typeof value !== "object") {
    if (isNonSerializable(value)) return null;
    return value as string | number | boolean | null;
  }

  if (depth >= 8) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitizeDraftValue(item, depth + 1));
  }

  if (isNonSerializable(value)) return null;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const sanitized = sanitizeDraftValue(item, depth + 1);
    if (sanitized !== null || item === null) {
      out[key] = sanitized;
    }
  }
  return out;
}

/**
 * Single source of truth for turning wizard state into persistable draft
 * input: sanitize → re-package → byte-gate. Both the client encoder and the
 * server action persist EXACTLY what this returns, so neither path can drift
 * into writing unsanitized payloads.
 *
 * Returns null when validation fails or the serialized form exceeds budget.
 * Callers that need to TELL THOSE APART (to report a stuck draft rather than
 * skipping in silence) should use `prepareDraftForPersistDetailed`.
 */
export function prepareDraftForPersist(
  input: unknown,
): SaveOnboardingDraftInput | null {
  const result = prepareDraftForPersistDetailed(input);
  return result.ok ? result.value : null;
}

/** Why a draft snapshot could not be persisted. */
export type DraftRejectionReason =
  /** Failed the wire schema — includes a role outside the three public flows. */
  | "INVALID"
  /** Sanitized fine, but the serialized form exceeds ONBOARDING_DRAFT_MAX_BYTES. */
  | "OVER_BUDGET";

export type PrepareDraftResult =
  | { ok: true; value: SaveOnboardingDraftInput }
  | { ok: false; reason: DraftRejectionReason; bytes?: number };

/**
 * The reason-carrying form. A silent `null` conflates "this payload is
 * malformed" with "this user has simply written too much", and only the
 * second one means an otherwise-healthy wizard has stopped saving — so the
 * caller needs to know which it got.
 */
export function prepareDraftForPersistDetailed(
  input: unknown,
): PrepareDraftResult {
  const parsed = SaveOnboardingDraftInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "INVALID" };

  const sanitizedPayload = sanitizeDraftValue(
    parsed.data.payload,
  ) as Record<string, unknown>;
  const prepared: SaveOnboardingDraftInput = {
    ...parsed.data,
    payload: sanitizedPayload,
  };

  const serialized = JSON.stringify(prepared);
  // Web-standard byte sizing: Buffer is a Node global present in client
  // bundles only via Next.js's incidental polyfill; TextEncoder is baseline
  // across runtimes and returns identical UTF-8 byte counts.
  const bytes = new TextEncoder().encode(serialized).length;
  if (bytes > ONBOARDING_DRAFT_MAX_BYTES) {
    return { ok: false, reason: "OVER_BUDGET", bytes };
  }
  return { ok: true, value: prepared };
}

/**
 * Restore Date-typed wizard fields from a JSON round-trip. Unknown or invalid
 * date fields are silently omitted — the step forms re-collect them, and a
 * hostile stored payload must never throw inside hydration.
 */
export function reviveDraftPayload(
  payload: unknown,
): Partial<Record<string, unknown>> {
  if (typeof payload !== "object" || payload === null) return {};
  const revived = DraftDateFieldsSchema.safeParse(payload);
  if (!revived.success) return { ...(payload as Record<string, unknown>) };
  return { ...(payload as Record<string, unknown>), ...revived.data };
}

/**
 * Client-side convenience: validate + sanitize a draft snapshot exactly the
 * way the server action will, so callers can skip no-op saves and surface
 * size problems before the request. Returns null when validation fails.
 */
export function encodeDraftForSave(
  input: SaveOnboardingDraftInput,
): SaveOnboardingDraftInput | null {
  return prepareDraftForPersist(input);
}

/** `encodeDraftForSave` with the rejection reason kept. */
export function encodeDraftForSaveDetailed(
  input: SaveOnboardingDraftInput,
): PrepareDraftResult {
  return prepareDraftForPersistDetailed(input);
}

/**
 * Serializes draft-save promises so a later wizard state can never be
 * overwritten by an earlier in-flight upsert (true last-write-wins), and so
 * lifecycle code can DRAIN every dispatched-but-unsettled save before the
 * draft row is deleted — an upsert landing after the delete would resurrect
 * stale state (review round 1, page.tsx).
 */
export interface DraftSaveQueue {
  /** Chains task after all previously enqueued tasks; rejects if task throws.
   *  A previous failure never blocks a later task from running. */
  enqueue<T>(task: () => Promise<T>): Promise<T>;
  /** Resolves once every enqueued task has settled (fulfilled or rejected). */
  drain(): Promise<void>;
}

export function createDraftSaveQueue(): DraftSaveQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue(task) {
      const run = tail.then(task, task);
      // Keep the internal chain alive regardless of this task's outcome;
      // `run` itself surfaces rejection to the caller to handle.
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    drain() {
      return tail.then(
        () => undefined,
        () => undefined,
      );
    },
  };
}

// Re-exported for actions that need the DOB schema's guarantees on the way
// back out of a draft; kept here so importers have one draft-module import.
export { DateOfBirthSchema };
