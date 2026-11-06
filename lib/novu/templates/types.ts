/**
 * Novu workflow templates as code.
 *
 * The workflows were built by hand in Novu's legacy editor and drifted from
 * `docs/notifications/03-novu-template-specs.md` the same week; the new
 * dashboard cannot edit them, and 48 ids the app triggers were never created
 * at all. This manifest is the source of truth; `scripts/novu/sync-workflows.ts`
 * writes it to the environment.
 *
 * Bodies are Liquid. Only `payload.*` and `subscriber.*` may be referenced —
 * a bare `{{status}}` is what the legacy templates did, and it renders empty.
 * One payload often reaches both parties, so a body names the plan and the
 * time and names a person only where every reader is the other party.
 */

import type { NOVU_WORKFLOWS } from "../workflows";

export type NovuWorkflowId =
  (typeof NOVU_WORKFLOWS)[keyof typeof NOVU_WORKFLOWS];

/**
 * The `NotificationPreference` switch a workflow honours, checked by the
 * server before every trigger. `null` is a system notice with no category.
 */
export type PreferenceCategory =
  | "appointments"
  | "payments"
  | "subscriptions"
  | "trials"
  | "support"
  | "feedback"
  | "orgBilling"
  | "orgMembership"
  | "orgProgram";

export type InAppTemplate = {
  /** Bold heading above the body. Keep it to a few words. */
  subject?: string;
  /** Liquid sentence. */
  body: string;
  /**
   * The payload field holding the destination (`dashboardUrl`, `payUrl`…).
   * Novu accepts only `{{var}}`, `http(s)://` or `/` at the start of a
   * redirect, so a family cannot branch there; `toWire` copies this field
   * into `payload.href` and every family redirects to `{{payload.href}}`.
   */
  redirect?: string;
};

export type WorkflowTemplate = {
  workflowId: NovuWorkflowId;
  name: string;
  /** Who receives it and why — read by the sync's dry-run and the dashboard. */
  description: string;
  category: PreferenceCategory | null;
  /**
   * A mandatory account, moderation or compliance notice: it rings even when
   * the recipient has turned bells off, like a required email. Needs `category: null`.
   */
  required?: true;
  inApp: InAppTemplate;
};
