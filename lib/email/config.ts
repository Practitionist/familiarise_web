import {
  BILLING_EMAIL,
  COMPANY_POSTAL_ADDRESS,
  CONTACT_INBOX_ADDRESS,
  EMAIL_NEWSLETTER_DOMAIN,
  EMAIL_TRANSACTIONAL_DOMAIN,
  SUPPORT_EMAIL,
} from "@/lib/company";

export function transactionalDomain(): string {
  return EMAIL_TRANSACTIONAL_DOMAIN;
}

export function newsletterDomain(): string {
  return EMAIL_NEWSLETTER_DOMAIN;
}

/** The address customers write to; also the default Reply-To on every send. */
export function supportEmail(): string {
  return SUPPORT_EMAIL;
}

/** Where /contactus inquiries land. */
export function contactInboxAddress(): string {
  return CONTACT_INBOX_ADDRESS;
}

/** The supplier contact printed on tax invoices. */
export function billingEmail(): string {
  return BILLING_EMAIL;
}

/** Postal line for email footers. */
export function companyPostalAddress(): string {
  return COMPANY_POSTAL_ADDRESS;
}

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
  /** The From header of every ops alert: the system address with a display name. */
  get ops(): string {
    return `Familiarise Ops <system@${transactionalDomain()}>`;
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
  CONTACT_AND_NEWSLETTER: 5_000,
  WEBHOOK: 3_000,
  JOB: 10_000,
  REQUEST: 5_000,
  LIFECYCLE: 5_000,
} as const;
