import * as Sentry from "@sentry/nextjs";

/**
 * Client-side onboarding breadcrumbs: context attached to the next Sentry
 * error, not a funnel (see docs/onboarding for the funnel query). Never log
 * field values — only step labels and outcome codes.
 */
export function trackOnboardingEvent(
  event:
    | "draft_restored"
    | "step_advance"
    | "step_back"
    | "draft_save_failed"
    | "draft_save_skipped"
    | "draft_load_failed"
    | "draft_quarantined"
    | "draft_conflict"
    | "submit_success"
    | "submit_error"
    // A client-side Zod refusal: the payload failed the form schema, so the
    // submit never left the browser. Distinct from `submit_error`, which is a
    // server refusal or a throw. Worth separating because only this one is
    // fixable by changing the form.
    | "submit_validation_failed"
    | "verification_deferred"
    | "invite_bypassed"
    | "invite_check_skipped",
  data?: Record<string, string | number | boolean | null>,
): void {
  try {
    Sentry.addBreadcrumb({
      category: "onboarding",
      message: event,
      level: "info",
      data,
    });
  } catch {
    // Telemetry must never break the wizard; swallow transport failures.
  }
}
