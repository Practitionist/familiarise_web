// #1298 — the old .com domain is not ours; identities live on familiarisenow.com,
// split mail. (transactional) / news. (newsletter) so reputations stay apart.

const DEFAULT_TRANSACTIONAL_DOMAIN = "mail.familiarisenow.com";
const DEFAULT_NEWSLETTER_DOMAIN = "news.familiarisenow.com";
const DEFAULT_SUPPORT_EMAIL = "support@familiarisenow.com";

// Static `process.env.X` reads (not a dynamic key) so Next.js can inline the
// NEXT_PUBLIC_ ones; a blank value counts as unset.
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function transactionalDomain(): string {
  return (
    nonEmpty(process.env.EMAIL_TRANSACTIONAL_DOMAIN) ??
    DEFAULT_TRANSACTIONAL_DOMAIN
  );
}

export function newsletterDomain(): string {
  return (
    nonEmpty(process.env.EMAIL_NEWSLETTER_DOMAIN) ?? DEFAULT_NEWSLETTER_DOMAIN
  );
}

/** The address customers write to; also the default Reply-To on every send. */
export function supportEmail(): string {
  return (
    nonEmpty(process.env.NEXT_PUBLIC_SUPPORT_EMAIL) ?? DEFAULT_SUPPORT_EMAIL
  );
}

/** Where /contactus inquiries land. Defaults to the support mailbox. */
export function contactInboxAddress(): string {
  return nonEmpty(process.env.CONTACT_INBOX_ADDRESS) ?? supportEmail();
}

/** The supplier contact printed on tax invoices. Defaults to the support mailbox. */
export function billingEmail(): string {
  return nonEmpty(process.env.BILLING_EMAIL) ?? supportEmail();
}

/** Optional postal line for email footers; the line is omitted when unset. */
export function companyPostalAddress(): string | undefined {
  return nonEmpty(process.env.NEXT_PUBLIC_COMPANY_POSTAL_ADDRESS);
}

// Getters so each read reflects the env at call time (tests override it).
// `system` is a bare address: an internal requester id, not a From header.
export const SENDERS = {
  get onboarding(): string {
    return `Familiarise <onboarding@${transactionalDomain()}>`;
  },
  get security(): string {
    return `Familiarise Security <security@${transactionalDomain()}>`;
  },
  get payments(): string {
    return `Familiarise Payments <payments@${transactionalDomain()}>`;
  },
  get notifications(): string {
    return `Familiarise <notifications@${transactionalDomain()}>`;
  },
  get newsletter(): string {
    return `Familiarise <newsletter@${newsletterDomain()}>`;
  },
  get finance(): string {
    return `Familiarise Finance <finance@${transactionalDomain()}>`;
  },
  get dpdp(): string {
    return `Familiarise DPDP <dpdp@${transactionalDomain()}>`;
  },
  get noreply(): string {
    return `Familiarise <noreply@${transactionalDomain()}>`;
  },
  get system(): string {
    return `system@${transactionalDomain()}`;
  },
};

// #474 — the retry worker's non-null `from` fallback for a row persisted
// without one. Mirrors the senders' onboarding identity.
export const DEFAULT_FROM_ADDRESS: string = SENDERS.onboarding;

// #1654 — inline send budgets per caller. A timeout is not a failure: the
// staged row stays PENDING and the relay finishes it, so the budget only
// bounds how long the caller's request waits. Shared with the Novu side.
export const EMAIL_BUDGET_MS = {
  AUTH: 8_000,
  CONTACT_AND_WAITLIST: 5_000,
  WEBHOOK: 3_000,
  JOB: 10_000,
} as const;
