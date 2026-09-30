/**
 * Shape of the Sentry triage data rendered by the back-office.
 *
 * Kept separate from `sentry-issues.ts` so the consumer — a server component
 * or an API route — can type its payload without importing the fetch machinery,
 * which is `server-only` and would drag `server-only` into a client bundle.
 */

/** One Sentry issue, reduced to what a support agent can act on. */
export interface SentryIssueSummary {
  /** e.g. `FAMILIARISE_WEB-5Y` — displayable, copy-pasteable, searchable. */
  shortId: string;
  title: string;
  /** The route or transaction the issue is attributed to, when Sentry knows. */
  culprit?: string;
  level?: string;
  lastSeen?: string;
  /** Deep link into the Sentry issue, where the stack and tags live. */
  permalink: string;
}

/**
 * `configured: false` means "no triage data available", covering both "no
 * token set" and "the lookup failed". The UI must render an empty state rather
 * than an error: a support agent triaging an incident should not be shown a
 * failure caused by the observability provider.
 */
export interface UserSentryIssues {
  configured: boolean;
  issues: SentryIssueSummary[] | null;
}
