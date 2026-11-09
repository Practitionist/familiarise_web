/**
 * Public help-center content model for `/support`.
 *
 * v1 is hardcoded TSX-adjacent data (no CMS/MDX in the repo) so content ships
 * with the app bundle, renders under ISR, and is reviewable in the same PR as
 * the UI. Answers are grounded in current product behavior — refund tiers,
 * hold windows, payout cadence, retention limits — and link back to the live
 * policy pages (`/refund`, `/pricing`, `/privacy`, `/terms`) as the source of
 * truth where money or compliance is involved.
 */

import { CASE_TOPICS, type CaseTopic } from "@/lib/support/case-topic";
import type { ArticleLink } from "@/types/support-case";

export interface SupportSubcategory {
  title: string;
  description: string;
}

export interface SupportCategory {
  slug: string;
  title: string;
  description: string;
  /** Key into the lucide icon map in `CategoryGrid.tsx` / `[category]/page.tsx`. */
  icon: string;
  subcategories: SupportSubcategory[];
}

export interface SupportSection {
  heading: string;
  paragraphs: string[];
  list?: string[];
}

export interface SupportArticle {
  slug: string;
  category: string;
  title: string;
  excerpt: string;
  updated: string;
  /** Value from INQUIRY_CATEGORIES (app/(pages)/constants.ts) for escalation. */
  contactCategory: string;
  /** `category/slug` pairs rendered as "Related articles". */
  related: string[];
  sections: SupportSection[];
}

/**
 * #1527 — which Help Center categories each dashboard audience draws its
 * suggested articles from. Learners never get the expert or organisation
 * topics.
 */
export type HelpCenterAudience = "learner" | "expert";

export const HELP_CENTER_AUDIENCE_CATEGORIES: Record<
  HelpCenterAudience,
  readonly string[]
> = {
  learner: [
    "getting-started",
    "booking",
    "payments",
    "video",
    "recordings",
    "help",
  ],
  expert: [
    "getting-started",
    "experts",
    "booking",
    "video",
    "recordings",
    "help",
  ],
};

export const supportCategories: SupportCategory[] = [
  {
    slug: "getting-started",
    title: "Getting started & account",
    description:
      "Sign up, sign in, verification, passwords, SSO, and managing your account and data.",
    icon: "account",
    subcategories: [
      {
        title: "Sign up & verification",
        description: "Create an account and verify your email address.",
      },
      {
        title: "Sign in & passwords",
        description: "Sign in, reset a forgotten password, or change it.",
      },
      {
        title: "Work SSO",
        description: "Sign in through your organisation's identity provider.",
      },
      {
        title: "Account & data",
        description: "Age requirements, consent, export, and deletion.",
      },
    ],
  },
  {
    slug: "booking",
    title: "Booking, rescheduling & cancellations",
    description:
      "Session types, picking slots, timezones, trials, rescheduling, cancellations, and no-shows.",
    icon: "booking",
    subcategories: [
      {
        title: "Finding & booking",
        description: "Session types, slots, timezones, and trials.",
      },
      {
        title: "Rescheduling",
        description: "Move a session, respond to proposals, withdraw requests.",
      },
      {
        title: "Cancelling & no-shows",
        description: "Refund percentages, deadlines, and missed sessions.",
      },
    ],
  },
  {
    slug: "payments",
    title: "Payments, refunds, credits & invoices",
    description:
      "Checkout failures, payment links, refunds, referral credits, GST invoices, and chargebacks.",
    icon: "payments",
    subcategories: [
      {
        title: "Paying",
        description: "Methods, failed payments, and expired payment links.",
      },
      {
        title: "Refunds",
        description:
          "Timelines, statuses, appeals, and how refund amounts work.",
      },
      {
        title: "Credits & invoices",
        description: "Referral credits, discounts, GST invoices, chargebacks.",
      },
    ],
  },
  {
    slug: "video",
    title: "Joining & troubleshooting video",
    description:
      "Pre-join checks, joining, drops and rejoins, recording consent, and in-session chat.",
    icon: "video",
    subcategories: [
      {
        title: "Joining",
        description: "How to join, devices, permissions, and join errors.",
      },
      {
        title: "During the call",
        description: "Drops, rejoining, recording consent, and chat.",
      },
    ],
  },
  {
    slug: "recordings",
    title: "Recordings, materials & documents",
    description:
      "Finding recordings, replays, expiry, uploading documents, and class materials.",
    icon: "recordings",
    subcategories: [
      {
        title: "Recordings & replays",
        description: "Access, processing delays, purchase, and expiry.",
      },
      {
        title: "Documents & materials",
        description: "Uploads for review and class handouts.",
      },
    ],
  },
  {
    slug: "experts",
    title: "For experts",
    description:
      "Verification, availability and pricing, booking requests, payouts, and reviews.",
    icon: "experts",
    subcategories: [
      {
        title: "Becoming an expert",
        description: "Verification documents and resubmission.",
      },
      {
        title: "Availability & requests",
        description: "Calendars, pricing, and handling booking requests.",
      },
      {
        title: "Earnings & reputation",
        description: "Payouts, TDS, reviews, and private feedback.",
      },
    ],
  },
  {
    slug: "organizations",
    title: "For organizations",
    description:
      "Sponsorship models, wallet and invoice billing, members and roles, SSO.",
    icon: "organizations",
    subcategories: [
      {
        title: "Plans & programs",
        description: "Sponsor vs host, seat packs, credit pools.",
      },
      {
        title: "Billing & members",
        description: "Wallet, invoices, invites, and roles.",
      },
      {
        title: "SSO & retention",
        description: "Identity setup, support, and data retention.",
      },
    ],
  },
  {
    slug: "help",
    title: "Notifications, privacy, security & getting help",
    description:
      "Notification preferences, cookies, safety, tickets, and contacting support.",
    icon: "help",
    subcategories: [
      {
        title: "Notifications",
        description: "Channels, categories, unsubscribe.",
      },
      {
        title: "Privacy & safety",
        description: "Cookies, data use, reporting, appeals.",
      },
      {
        title: "Getting help",
        description: "Tickets, contact options, and platform status.",
      },
    ],
  },
];

export const supportArticles: SupportArticle[] = [
  // ─── Getting started & account ──────────────────────────────────────────
  {
    slug: "how-to-sign-up",
    category: "getting-started",
    title: "How do I sign up and verify my email?",
    excerpt:
      "Create your account, verify your email address, and know what to do if the link expires.",
    updated: "September 2026",
    contactCategory: "general",
    related: ["getting-started/sign-in-and-password", "booking/session-types"],
    sections: [
      {
        heading: "Create your account",
        paragraphs: [
          "Choose Sign up and register with your email address and a password, or continue with a linked social account where offered. You will pick a role — consultee (learner) or consultant (expert) — and can complete a short onboarding profile afterwards.",
          "Onboarding saves as you go, so you can leave and return without losing progress.",
        ],
      },
      {
        heading: "Verify your email",
        paragraphs: [
          "We send a verification link to the address you registered with. Open it within its validity window to activate full access. If the link expired, sign in and request a new one from the verification banner.",
        ],
        list: [
          "Check spam and promotions folders before requesting a resend.",
          "Use the latest link — older links are invalidated when a new one is sent.",
          "Still nothing? Contact us with the exact email address you registered.",
        ],
      },
    ],
  },
  {
    slug: "sign-in-and-password",
    category: "getting-started",
    title: "I forgot my password — how do I sign back in?",
    excerpt:
      "Reset a forgotten password, change a known one, and fix common sign-in errors.",
    updated: "September 2026",
    contactCategory: "general",
    related: ["getting-started/how-to-sign-up", "getting-started/sso-sign-in"],
    sections: [
      {
        heading: "Reset a forgotten password",
        paragraphs: [
          "Choose Forgot password on the sign-in page, enter your account email, and follow the reset link we send. Links are single-use and time-limited — request a fresh one if yours expired.",
        ],
      },
      {
        heading: "Change a known password",
        paragraphs: [
          "Sign in, open Settings, and use Change password. You will need your current password to set a new one.",
        ],
      },
      {
        heading: "If sign-in still fails",
        paragraphs: [
          "The on-screen error message names the cause in most cases — for example an unverified email, a mistyped address, or a locked social-login link. If your work email redirects you to single sign-on instead, follow the SSO steps rather than a password reset.",
        ],
      },
    ],
  },
  {
    slug: "sign-in-again-at-checkout",
    category: "getting-started",
    title: "Why am I asked to sign in again to continue checkout?",
    excerpt:
      "Your booking selection is saved — sign in to continue exactly where you left off.",
    updated: "September 2026",
    contactCategory: "booking",
    related: ["booking/picking-slots", "payments/payment-methods-and-failures"],
    sections: [
      {
        heading: "Your selection is saved",
        paragraphs: [
          "Checkout requires a signed-in account so the booking, payment, and receipts attach to the right person. If your session expired mid-checkout, sign in when prompted — your selected expert, plan, and slots are preserved and you continue from the same step.",
        ],
      },
      {
        heading: "What to check",
        paragraphs: [
          "Use the same email you started checkout with; a different account will not see the saved selection. If slots show as unavailable after signing back in, another learner may have booked them first — pick the nearest available alternative.",
        ],
      },
    ],
  },
  {
    slug: "sso-sign-in",
    category: "getting-started",
    title: "How do I sign in with my organisation's SSO?",
    excerpt:
      "Use your work email, what each SSO error means, and when to ask your IT admin.",
    updated: "September 2026",
    contactCategory: "technical",
    related: [
      "organizations/sso-setup",
      "getting-started/sign-in-and-password",
    ],
    sections: [
      {
        heading: "Sign in with SSO",
        paragraphs: [
          "Enter your work email on the sign-in page. If your organisation enforces single sign-on for that domain, you are redirected to your identity provider to authenticate, then returned to Familiarise automatically.",
        ],
      },
      {
        heading: "Common errors",
        paragraphs: [
          "Most SSO failures name the fix on screen. A missing redirect or certificate message means your provider's configuration (such as the X.509 certificate) needs attention from your IT admin. A no-provider message means that email domain has no SSO configured — sign in with your password instead or ask your admin to set it up.",
        ],
        list: [
          "Sign-in did not redirect: provider certificate or settings invalid — contact your IT admin.",
          "No SSO provider for domain: use password sign-in or ask your admin to configure SSO.",
          "Certificate expiring: admins receive expiry alerts — rotate the certificate before it lapses.",
        ],
      },
    ],
  },
  {
    slug: "age-consent-delete-data",
    category: "getting-started",
    title: "Age requirements, consent, and deleting my data",
    excerpt:
      "Why you must be 18+, how consent works, and how to export or erase your data.",
    updated: "September 2026",
    contactCategory: "general",
    related: ["help/privacy-cookies-safety", "help/tickets-and-contact"],
    sections: [
      {
        heading: "You must be at least 18",
        paragraphs: [
          "Familiarise is an adult learning platform. You must be 18 or older to register, and your date of birth is checked at onboarding. Accounts that do not meet the age requirement cannot proceed.",
        ],
      },
      {
        heading: "Consent",
        paragraphs: [
          "By registering and booking you accept the Terms and Privacy Policy; we record when each consent was given. Withdrawing consent for essential processing blocks new bookings because we can no longer fulfil them.",
        ],
      },
      {
        heading: "Export or erase your data",
        paragraphs: [
          "You can request a copy of your data or request erasure from your account settings or by contacting support. Erasure removes your personal information while retaining records the law requires us to keep, such as invoices and payout records (typically 5–7 years under Indian tax law). Messages and bookings tied to other users may be anonymised rather than deleted.",
        ],
      },
    ],
  },

  // ─── Booking ────────────────────────────────────────────────────────────
  {
    slug: "session-types",
    category: "booking",
    title: "What session types can I book?",
    excerpt:
      "1-on-1 consultations, subscriptions, classes, and webinars — how they differ.",
    updated: "September 2026",
    contactCategory: "booking",
    related: ["booking/picking-slots", "payments/refunds-explained"],
    sections: [
      {
        heading: "The four offerings",
        paragraphs: [
          "Experts publish four kinds of services. Each has different scheduling, pricing, and cancellation rules, so check the listing before you pay.",
        ],
        list: [
          "1-on-1 consultation: a private session with one expert at a mutually agreed slot.",
          "Subscription: ongoing mentoring over a period, with multiple sessions and anytime cancellation (current period is not refunded, access continues till period end).",
          "Class: a structured group course with a fixed schedule and tiered cancellation deadlines.",
          "Webinar: a large live event or workshop, usually a single date and time.",
        ],
      },
    ],
  },
  {
    slug: "picking-slots",
    category: "booking",
    title: "How do I pick slots? Why must sessions be consecutive?",
    excerpt:
      "Selecting slots, the consecutive-slot rule, and what “slot no longer available” means.",
    updated: "September 2026",
    contactCategory: "booking",
    related: ["booking/timezones", "booking/reschedule"],
    sections: [
      {
        heading: "Selecting slots",
        paragraphs: [
          "Listings that need scheduling show the expert's available times. Select the required number of slots, then continue to checkout. Availability combines the expert's weekly recurrence with any custom dates they added.",
        ],
      },
      {
        heading: "Why consecutive slots?",
        paragraphs: [
          "Some multi-session plans require back-to-back slots so the session runs uninterrupted. The picker guides you: it confirms when all required slots are selected and warns when there are not enough consecutive slots left. If you see “this slot is no longer available,” another learner booked it first — choose the nearest alternative.",
        ],
      },
    ],
  },
  {
    slug: "timezones",
    category: "booking",
    title: "How do timezones work when booking?",
    excerpt:
      "Scheduling timezone vs display timezone, and avoiding timezone mix-ups.",
    updated: "September 2026",
    contactCategory: "booking",
    related: ["booking/picking-slots", "experts/availability-and-pricing"],
    sections: [
      {
        heading: "One scheduling timezone per booking",
        paragraphs: [
          "Every booking is anchored to a single scheduling timezone so both sides mean the same moment. Slots are stored in UTC internally and shown in your browser's timezone.",
        ],
      },
      {
        heading: "Avoiding mix-ups",
        paragraphs: [
          "Double-check the timezone label beside each slot before paying, especially when travelling — your browser zone may differ from your home zone. Calendar invites and reminders use the same scheduled moment, so add them without converting manually. If a session time looks wrong, confirm your device timezone first, then contact support.",
        ],
      },
    ],
  },
  {
    slug: "reschedule",
    category: "booking",
    title: "How do I reschedule a session?",
    excerpt:
      "The one free reschedule, expert proposals, auto-confirmation, and withdrawing requests.",
    updated: "September 2026",
    contactCategory: "booking",
    related: ["booking/cancel-and-no-show", "booking/picking-slots"],
    sections: [
      {
        heading: "Requesting a reschedule",
        paragraphs: [
          "Open the appointment from My Bookings and choose Reschedule. Your first reschedule requested more than 24 hours before the session is free. Proposals need at least a 24-hour margin, and in some cases the expert's acceptance auto-confirms the new time.",
        ],
      },
      {
        heading: "Proposals and withdrawals",
        paragraphs: [
          "Either side can propose a new time; you will be notified to accept or decline. You can withdraw your pending request to restore the original booking. Only one active reschedule per appointment is allowed, so resolve or withdraw the current one before starting another.",
        ],
      },
    ],
  },
  {
    slug: "cancel-and-no-show",
    category: "booking",
    title: "Cancellations, refunds by session type, and no-shows",
    excerpt:
      "Refund percentages and deadlines, the cancellation preview, and what happens on a no-show.",
    updated: "September 2026",
    contactCategory: "booking",
    related: ["payments/refunds-explained", "booking/reschedule"],
    sections: [
      {
        heading: "Refund tiers (your booking's preview is binding)",
        paragraphs: [
          "Every booking snapshots its cancellation terms at purchase, so open the appointment and choose Cancel to see a live preview of your exact refund before confirming. As a guide, the platform default ladder is: 24 hours or more before — 100%; 2 to under 24 hours — 50%; under 2 hours — 0%. Organisation and program-specific policies may set different tiers, and the policy attached to your booking governs.",
        ],
        list: [
          "Subscription: cancel anytime; the current period is not refunded, access continues till it ends.",
          "Consultant-initiated cancellations always refund in full.",
        ],
      },
      {
        heading: "No-shows",
        paragraphs: [
          // #1569 B2: replaces the consultation-only description with the
          // owner-decided void rule (D1) and remedy (D4/D7), which now
          // covers every session shape, not just one-to-one consultations.
          "If a session's host is absent for at least 15 minutes of the booked time, or for half of it on sessions shorter than 30 minutes, the session is voided. For a one-to-one consultation, a host no-show is refunded in full automatically. For classes and webinars, we first offer a free make-up session within 14 days; if it goes unused, that session is refunded automatically. For subscriptions, a voided session is returned to your plan's allowance instead, and any voided session that's still unused when your plan or billing cycle ends is refunded automatically. If you miss the session as the learner, no refund applies, but you'll get a support link — and a link to the recording, when your plan records sessions — in case something on our side kept you out; support can review and correct the outcome if it was recorded incorrectly. Sessions held outside the platform are marked inconclusive and handled case by case — contact support with evidence.",
        ],
      },
    ],
  },

  // ─── Payments ───────────────────────────────────────────────────────────
  {
    slug: "payment-methods-and-failures",
    category: "payments",
    title: "Which payment methods work, and why did my payment fail?",
    excerpt:
      "UPI, cards, netbanking, and wallets via Razorpay — plus failure fixes.",
    updated: "September 2026",
    contactCategory: "billing",
    related: [
      "payments/deducted-but-unconfirmed",
      "payments/payment-link-expired",
    ],
    sections: [
      {
        heading: "Supported methods",
        paragraphs: [
          "Checkout accepts UPI, credit and debit cards, netbanking, and wallets through Razorpay, including international cards. Prices are set by experts with the platform fee included in the displayed price, and INR is the default currency.",
        ],
      },
      {
        heading: "If your payment fails",
        paragraphs: [
          "The failure page explains the reason in most cases. Common fixes: retry with a different method, confirm UPI and card limits with your bank, and avoid closing the window while the gateway confirms. Do not pay twice for the same booking — check My Bookings first, then contact support with the payment reference if money left your account.",
        ],
      },
    ],
  },
  {
    slug: "deducted-but-unconfirmed",
    category: "payments",
    title: "Money left my account but the booking is unconfirmed — what now?",
    excerpt:
      "Why the payment webhook is the authority, and the exact steps to recover.",
    updated: "September 2026",
    contactCategory: "billing",
    related: [
      "payments/payment-methods-and-failures",
      "payments/refunds-explained",
    ],
    sections: [
      {
        heading: "Do not pay again yet",
        paragraphs: [
          "Confirmation arrives via the payment gateway's secure callback, which can lag a failed-looking checkout page. Wait a few minutes, then check My Bookings and your email for confirmation before retrying.",
        ],
      },
      {
        heading: "Recover step by step",
        paragraphs: [
          "If the booking is still unconfirmed after 30 minutes, open the failure page's support link or contact us with the payment ID, amount, time, and screenshots of the debit. Genuine deductions for unconfirmed bookings are reconciled to a refund — you will not lose the money.",
        ],
      },
    ],
  },
  {
    slug: "payment-link-expired",
    category: "payments",
    title: "My payment link expired — how do I get a new one?",
    excerpt:
      "The 24-hour payment window, reminders, and requesting a fresh link.",
    updated: "September 2026",
    contactCategory: "billing",
    related: ["payments/payment-methods-and-failures", "booking/picking-slots"],
    sections: [
      {
        heading: "The 24-hour window",
        paragraphs: [
          "Payment links for approved bookings stay valid for 24 hours. We send reminders before expiry, but an expired link cannot be revived for security reasons.",
        ],
      },
      {
        heading: "Get a fresh link",
        paragraphs: [
          "Contact the expert or support to re-issue the payment link, then complete payment promptly. Your slots may need re-confirmation if the expert's calendar changed meanwhile.",
        ],
      },
    ],
  },
  {
    slug: "refunds-explained",
    category: "payments",
    title: "How and when do refunds arrive?",
    excerpt:
      "7–14 day timeline, status meanings, appeals, and how the refund amount is set.",
    updated: "September 2026",
    contactCategory: "billing",
    related: ["booking/cancel-and-no-show", "payments/gst-invoices"],
    sections: [
      {
        heading: "Timeline and destination",
        paragraphs: [
          "Refunds go only to the original payment method (UPI refunds return to the same UPI ID, card refunds to the same card). After approval, allow a review window plus bank processing — typically 7–14 days end to end. The refund is the percentage of the amount you paid (GST included) that your booking's cancellation terms allow, shown in the cancel dialog before you confirm; Familiarise does not deduct the platform fee or the payment gateway's charges from it. For example, if you paid ₹1,180 (₹1,000 plus 18% GST) and the terms give 50%, you receive ₹590.",
        ],
      },
      {
        heading: "Statuses and appeals",
        paragraphs: [
          "Track your refund as Pending review, Approved, Processing, Completed, or Rejected. If rejected, you can appeal within 7 days with supporting documents; re-evaluation typically takes up to 5 days. Full details are on the Cancellation & Refund Policy page, which governs in case of any difference.",
        ],
        list: [
          "Pending review: your request is queued.",
          "Approved / Processing: money is on its way through the gateway and bank.",
          "Completed: the refund has left our side — check your statement.",
          "Rejected: reason shown — appeal within 7 days.",
        ],
      },
    ],
  },
  {
    slug: "referral-credits",
    category: "payments",
    title: "How do referral credits and discounts work?",
    excerpt:
      "Earning, minimums, expiry, FIFO use — and why credits come back on refund.",
    updated: "September 2026",
    contactCategory: "billing",
    related: ["payments/refunds-explained", "getting-started/how-to-sign-up"],
    sections: [
      {
        heading: "Earning and using credits",
        paragraphs: [
          "A friend who joins through your link gets a discount on their first booking of up to 20%, at most ₹300, taken off the price before tax. The discount is limited by the platform's fee on that booking, so it is often less. You earn up to ₹300 of credit after your friend's first paid session has taken place and its refund window has passed; if that booking is refunded or charged back, the credit is cancelled.",
          "Credit applies automatically at checkout on orders of ₹500 or more, oldest-expiring first, and can cover up to 20% of a booking (less on an expert's own-link bookings). Together with any discount, it never exceeds the platform's fee on that booking. Credit expires 90 days after it becomes spendable, is INR-only and cannot be withdrawn or transferred.",
          "Your referral link is on the Invite & earn page of your dashboard. A referral counts when the person you invited makes their first paid booking within 30 days of signing up; a sign-up alone earns nothing.",
        ],
      },
      {
        heading: "Refunds and missing credits",
        paragraphs: [
          "When a booking paid partly with credits is refunded, consumed credits are restored unless they already expired. If your balance shows zero unexpectedly, it is usually a failed fetch rather than lost credits — refresh, and contact support only if the balance stays wrong after a minute.",
        ],
      },
    ],
  },
  {
    slug: "gst-invoices",
    category: "payments",
    title: "Where is my GST invoice? What about chargebacks?",
    excerpt:
      "Downloading invoices and credit notes, billing state, and why chargebacks risk suspension.",
    updated: "October 2026",
    contactCategory: "billing",
    related: [
      "payments/refunds-explained",
      "organizations/wallet-invoice-billing",
    ],
    sections: [
      {
        heading: "Invoices and credit notes",
        paragraphs: [
          "Download your GST invoice from the payment record in your dashboard. Set your billing state correctly at checkout so the invoice splits CGST/SGST (same state) or IGST (different state) properly. Refunds that adjust tax generate a credit note against the same invoice.",
        ],
      },
      {
        heading: "Do not charge back first",
        paragraphs: [
          "Report a problem before asking your bank to reverse a charge. A chargeback (payment dispute) freezes the amount on both sides, blocks further booking actions on the appointment while the chargeback is open, and may lead to account suspension. We usually fix billing problems faster than banks do.",
        ],
      },
    ],
  },

  // ─── Video ──────────────────────────────────────────────────────────────
  {
    slug: "how-to-join",
    category: "video",
    title: "How do I join my video session?",
    excerpt:
      "Joining from your dashboard or email, the lobby check, and permissions.",
    updated: "September 2026",
    contactCategory: "technical",
    related: ["video/join-errors", "video/dropped-call"],
    sections: [
      {
        heading: "Join from your booking",
        paragraphs: [
          "Open the appointment in My Bookings shortly before start time and choose Join. The lobby lets you preview your camera and microphone, pick speaker and camera devices, and confirm permissions before entering.",
        ],
      },
      {
        heading: "Device tips",
        paragraphs: [
          "Use a current Chrome, Edge, Firefox, or Safari on a stable connection. Allow camera and microphone when the browser asks — you can keep the camera off and still participate with audio. Join links are personal; do not share yours.",
        ],
      },
    ],
  },
  {
    slug: "join-errors",
    category: "video",
    title:
      "“Doesn't exist”, “not authorized”, or “failed to join” — what to do?",
    excerpt: "What each join error means and the fix for each.",
    updated: "September 2026",
    contactCategory: "technical",
    related: ["video/how-to-join", "booking/cancel-and-no-show"],
    sections: [
      {
        heading: "Match the message",
        paragraphs: [
          "Each error points at a different cause, so match yours before retrying.",
        ],
        list: [
          "Need to log in: sign in with the account that made the booking, then rejoin.",
          "Doesn't exist or ended: the session window closed or was cancelled — check My Bookings for the current status.",
          "Not authorized: you are signed in as a different user, or the booking belongs to another account or organisation seat.",
          "Failed to join: usually network or permissions — refresh, allow camera/mic, and try a supported browser.",
        ],
      },
    ],
  },
  {
    slug: "dropped-call",
    category: "video",
    title: "My call dropped — how do I rejoin?",
    excerpt:
      "Offline vs reconnecting states, the Rejoin button, and camera behavior.",
    updated: "September 2026",
    contactCategory: "technical",
    related: ["video/how-to-join", "recordings/finding-recordings"],
    sections: [
      {
        heading: "Rejoin, don't panic",
        paragraphs: [
          "Brief drops reconnect automatically. If you see a Rejoin option, choose it — your previous microphone and camera state is restored, and the camera is never forced on. A persistent “you are offline” message means your own connection is down: check Wi-Fi or mobile data first.",
        ],
      },
      {
        heading: "If you cannot get back in",
        paragraphs: [
          "Refresh the meeting page once, then rejoin from My Bookings. If the session ended while you were away, attendance records still show your partial presence, which support can verify for refund or reschedule decisions.",
        ],
      },
    ],
  },
  {
    slug: "recording-consent",
    category: "video",
    title: "Will my session be recorded? Can I decline?",
    excerpt:
      "1-on-1 decline-and-still-join vs group sessions where recording is included.",
    updated: "September 2026",
    contactCategory: "technical",
    related: ["recordings/finding-recordings", "recordings/recording-expiry"],
    sections: [
      {
        heading: "1-on-1 sessions",
        paragraphs: [
          "For private consultations you can decline recording and still join — the session simply will not be recorded or available afterwards. You can change your choice before joining from the consent prompt.",
        ],
      },
      {
        heading: "Group sessions, classes, webinars",
        paragraphs: [
          "Recording is part of what group participants paid for, so joining means accepting it. If you do not consent, cancel for a refund under the normal policy instead of joining. If any participant declines mid-session, recording stops for everyone.",
        ],
      },
    ],
  },
  {
    slug: "session-chat",
    category: "video",
    title: "Where is the chat during and after my session?",
    excerpt: "In-call chat, post-session access, and retention windows.",
    updated: "September 2026",
    contactCategory: "technical",
    related: ["recordings/class-materials", "video/dropped-call"],
    sections: [
      {
        heading: "During and after",
        paragraphs: [
          "Each session has its own chat channel for links, notes, and follow-ups shared during the call. The channel stays available after the session so you can retrieve what was posted.",
        ],
      },
      {
        heading: "Retention",
        paragraphs: [
          "Chat history is kept for up to a year (shorter for some organisation plans), while recordings expire sooner. Save anything important promptly rather than relying on long-term access.",
        ],
      },
    ],
  },

  // ─── Recordings & documents ─────────────────────────────────────────────
  {
    slug: "finding-recordings",
    category: "recordings",
    title: "Where are my session recordings?",
    excerpt:
      "Finding recordings in your dashboard and what “processing” means.",
    updated: "September 2026",
    contactCategory: "technical",
    related: ["video/recording-consent", "recordings/recording-expiry"],
    sections: [
      {
        heading: "Open your recordings",
        paragraphs: [
          "Recordings appear under the appointment and on your Recordings page once published. A “processing” state right after the session is normal — encoding takes time, so wait before reporting it missing.",
        ],
      },
      {
        heading: "If a recording never appears",
        paragraphs: [
          "First confirm recording was consented and enabled for that session (declined 1-on-1 sessions are never recorded). If an expected recording is still missing well after the session, contact support with the appointment date and expert name.",
          "Experts can also press Sync from Stream on their Recordings page, which checks the video provider for recordings that have not been linked to their session yet.",
        ],
      },
    ],
  },
  {
    slug: "replay-purchase",
    category: "recordings",
    title: "Can I buy a replay of a past class or webinar?",
    excerpt: "How recording purchases work and who can watch.",
    updated: "September 2026",
    contactCategory: "booking",
    related: ["recordings/finding-recordings", "booking/session-types"],
    sections: [
      {
        heading: "Buying a replay",
        paragraphs: [
          "Experts may list recordings of past classes and webinars for purchase. Buying a replay gives your account viewing access without attending live — find purchasable replays on the expert's page or the recordings catalogue.",
        ],
      },
    ],
  },
  {
    slug: "recording-expiry",
    category: "recordings",
    title: "How long do recordings stay available?",
    excerpt: "The 90-day retention window and transferring what matters.",
    updated: "September 2026",
    contactCategory: "general",
    related: ["recordings/finding-recordings", "video/session-chat"],
    sections: [
      {
        heading: "90-day retention",
        paragraphs: [
          "Session recordings are retained for about 90 days (organisation plans may set their own window). Expiring recordings may be transferred or flagged before removal — download or save anything you need well before expiry.",
        ],
        list: [
          "Watch or download important recordings within the first weeks.",
          "Do not treat recordings as permanent storage.",
          "Organisation learners: your admin's retention setting governs your access.",
        ],
      },
    ],
  },
  {
    slug: "uploading-documents",
    category: "recordings",
    title: "How do I share documents for expert review?",
    excerpt:
      "Upload limits, formats, and what reviewed and deleted states mean.",
    updated: "September 2026",
    contactCategory: "technical",
    related: ["recordings/class-materials", "booking/session-types"],
    sections: [
      {
        heading: "Uploading",
        paragraphs: [
          "Attach resumes, portfolios, or assignments to the appointment from your dashboard before the session. Keep files within the stated size and count limits and prefer common formats (PDF, DOC, images) so the expert can open them.",
        ],
      },
      {
        heading: "Review states",
        paragraphs: [
          "A reviewed marker means the expert opened your file; deleted files show as a tombstone and cannot be restored. Upload replacements as new files rather than editing in place.",
        ],
      },
    ],
  },
  {
    slug: "class-materials",
    category: "recordings",
    title: "Where are class handouts and pre-reads?",
    excerpt: "Finding resources, plan materials, and organisation handouts.",
    updated: "September 2026",
    contactCategory: "booking",
    related: ["recordings/uploading-documents", "booking/session-types"],
    sections: [
      {
        heading: "Check the Resources area",
        paragraphs: [
          "Classes and programs publish handouts, slides, and pre-reads under the appointment or program Resources section. Organisation-sponsored programs may mirror shared plan materials from the organisation library.",
        ],
        list: [
          "Look under Resources on the appointment or program page.",
          "Pre-reads usually appear before the first session; slides after each session.",
          "Missing something the expert promised? Message them or contact support.",
        ],
      },
    ],
  },

  // ─── For experts ────────────────────────────────────────────────────────
  {
    slug: "become-expert",
    category: "experts",
    title: "How do I become an expert? What if verification is rejected?",
    excerpt:
      "Verification documents, review, and how to resubmit after rejection.",
    updated: "September 2026",
    contactCategory: "consultant",
    related: ["experts/availability-and-pricing", "experts/reviews-feedback"],
    sections: [
      {
        heading: "Apply and verify",
        paragraphs: [
          "Apply from Become an expert with your profile, credentials, and identity or qualification documents. Each document is reviewed individually, and approval unlocks publishing offerings.",
        ],
      },
      {
        heading: "If rejected",
        paragraphs: [
          "A rejection names the reason per document — for example an unreadable scan or a mismatched name. Fix exactly what is flagged and resubmit; unrelated approved documents stay approved.",
        ],
      },
    ],
  },
  {
    slug: "availability-and-pricing",
    category: "experts",
    title: "How do I set availability and prices?",
    excerpt:
      "Weekly vs custom slots, pricing, and what narrowing availability does.",
    updated: "September 2026",
    contactCategory: "consultant",
    related: ["experts/booking-requests", "booking/picking-slots"],
    sections: [
      {
        heading: "Weekly and custom availability",
        paragraphs: [
          "Set recurring weekly hours for your normal schedule and add custom dates for exceptions. Set per-plan pricing in INR; the displayed price includes the platform fee. Keep your calendar current — stale availability creates bookings you must then reject or reschedule.",
        ],
      },
      {
        heading: "Narrowing availability",
        paragraphs: [
          "Removing hours flags your upcoming uncovered sessions so you can re-allocate or contact affected learners early. Never narrow availability to dodge an existing booking — cancel or reschedule it properly instead.",
        ],
      },
    ],
  },
  {
    slug: "booking-requests",
    category: "experts",
    title: "How do I handle booking requests?",
    excerpt:
      "Approve, reject, or allocate slots — and what rejection triggers.",
    updated: "September 2026",
    contactCategory: "consultant",
    related: ["experts/availability-and-pricing", "booking/reschedule"],
    sections: [
      {
        heading: "The requests inbox",
        paragraphs: [
          "Bookings needing your confirmation appear in your Requests inbox with the learner's details and proposed times. Approve to confirm, allocate specific slots where the plan requires it, or reject to decline.",
        ],
      },
      {
        heading: "Rejection refunds automatically",
        paragraphs: [
          "Rejecting a pending request triggers an automatic refund of the full refundable amount to the learner — no separate action needed. The exact split follows the Cancellation & Refund Policy. Respond before requests expire so learners are not left waiting.",
        ],
      },
    ],
  },
  {
    slug: "payouts",
    category: "experts",
    title: "When and how do I get paid?",
    excerpt:
      "Weekly Monday batches, holds, bank setup, TDS, and bank-return errors.",
    updated: "September 2026",
    contactCategory: "consultant",
    related: ["experts/booking-requests", "payments/gst-invoices"],
    sections: [
      {
        heading: "Payout rhythm",
        paragraphs: [
          "Earnings move through Available, On hold (until the hold date, protecting against cancellations), and Paid out. Payouts batch weekly on Mondays to your registered bank account, net of TDS deducted under section 194-O. Add your bank details in payout settings — payouts only begin once they are verified.",
        ],
      },
      {
        heading: "Hold periods and the minimum payout",
        paragraphs: [
          "Each earning is held for a short period after the later of the payment and the end of the session, so a cancellation or refund can still be settled. The hold is 24 hours for consultations and classes, 48 hours for webinars, and 7 days for subscriptions; moving a session moves its release date with it.",
          "A payout is sent once your available balance reaches ₹500. Smaller balances stay available and join the next payout. An earning marked Refunded was returned to the learner after a cancellation and is not paid out. On bookings you sell yourself, Familiarise keeps a 20% platform fee; sessions an organisation pays for follow that organisation's agreement.",
        ],
      },
      {
        heading: "Bank errors and eligibility",
        paragraphs: [
          "A “returned by your bank” or “rejected transfer” status means your bank refused the credit — verify account number, IFSC, and name match, then re-trigger. Payouts are currently India-only; experts outside India cannot receive bank payouts yet.",
        ],
      },
    ],
  },
  {
    slug: "reviews-feedback",
    category: "experts",
    title: "How do reviews and private feedback work? Can I reply?",
    excerpt:
      "Public reviews vs private 1–5 ratings, replies, and low-score handling.",
    updated: "September 2026",
    contactCategory: "consultant",
    related: ["experts/become-expert", "booking/cancel-and-no-show"],
    sections: [
      {
        heading: "Two feedback channels",
        paragraphs: [
          "Learners can leave a public written review and a private 1–5 rating per appointment. Private ratings feed your aggregate score; public reviews build your profile. You can reply to public reviews — a calm, specific response helps future learners.",
        ],
      },
      {
        heading: "Unfair scores",
        paragraphs: [
          "Low ratings carry a cause (for example scheduling or technical issues). Ratings caused by proven platform faults can be excluded from your aggregate after review — contact support with the appointment reference instead of asking the learner to change it.",
        ],
      },
    ],
  },

  // #1527 — migrated from the retired dashboard expert FAQ, re-verified
  // against current behaviour so the Help Center is the single source.
  {
    slug: "expert-profile",
    category: "experts",
    title: "How do I set up my expert profile?",
    excerpt:
      "Your expertise, headline, background, and credentials — and where each one lives.",
    updated: "September 2026",
    contactCategory: "consultant",
    related: ["experts/become-expert", "experts/create-offerings"],
    sections: [
      {
        heading: "Profile",
        paragraphs: [
          "Open Settings and choose Profile. Pick your field of expertise, then add specialties and skills so learners searching for a topic can find you. Your headline, professional summary, years of experience, mentoring style, and an optional video introduction make up the story on your public page, and the languages you speak help learners choose.",
        ],
      },
      {
        heading: "Experience, education, and verification",
        paragraphs: [
          "Settings › Experience & education holds your work history, education, certifications, and achievements. Settings › Verification is where you upload the documents that let you publish offerings; each document is reviewed on its own.",
        ],
      },
    ],
  },
  {
    slug: "create-offerings",
    category: "experts",
    title: "How do I create, publish, and duplicate offerings?",
    excerpt:
      "The four offering types, drafts, publishing, duplicating, archiving, and deleting.",
    updated: "September 2026",
    contactCategory: "consultant",
    related: ["booking/session-types", "experts/availability-and-pricing"],
    sections: [
      {
        heading: "Create and publish",
        paragraphs: [
          "Open any Sell page, choose New, and pick a 1-on-1 consultation, a subscription, a webinar, or a class. Each editor asks for a title, description, topics, learning outcomes, prerequisites, who it is for, what is included, and a price, plus the scheduling details its type needs.",
          "Save draft keeps an offering private while you work on it: drafts never appear on your public page. Publish makes it bookable. A published consultation or subscription can be taken back to draft, while a published webinar or class cannot.",
        ],
      },
      {
        heading: "Duplicate, archive, or delete",
        paragraphs: [
          "Duplicate opens a new draft prefilled from an existing offering, so a variation takes minutes. Delete is offered only for an offering nobody has booked or paid for; once there is booking history, archive it instead, which hides it from new learners and keeps the history intact.",
        ],
      },
    ],
  },
  {
    slug: "trial-sessions",
    category: "experts",
    title: "How do trial sessions work?",
    excerpt:
      "Offering a trial on a subscription, answering trial requests, and what happens after.",
    updated: "September 2026",
    contactCategory: "consultant",
    related: ["experts/booking-requests", "experts/create-offerings"],
    sections: [
      {
        heading: "Offering a trial",
        paragraphs: [
          "Trials belong to subscription plans. In the subscription editor, turn on Offer a trial session, choose a length between 15 and 120 minutes, and set a trial price in whole rupees. A small price usually means fewer no-shows, but ₹0 makes the trial free.",
        ],
      },
      {
        heading: "Answering trial requests",
        paragraphs: [
          "Learners request a trial from your public page, and the request arrives in Requests under Trials. Accept it by picking a time, or decline it; a learner who paid for a declined trial is refunded automatically. Each learner can take one trial with you.",
        ],
      },
      {
        heading: "After the trial",
        paragraphs: [
          "Once the trial is held, the learner can subscribe to the plan from your page. A trial that leads to a subscription is marked as converted.",
        ],
      },
    ],
  },
  {
    slug: "collaborations",
    category: "experts",
    title: "How do collaborations and revenue sharing work?",
    excerpt:
      "Co-delivering webinars and classes with other experts, their roles, and how revenue is split.",
    updated: "September 2026",
    contactCategory: "consultant",
    related: ["experts/create-offerings", "experts/payouts"],
    sections: [
      {
        heading: "Inviting collaborators",
        paragraphs: [
          "The host of a webinar or class can invite other experts to deliver it with them. Invitations you send and receive live under Inbox › Collaborations, where each invited expert accepts or declines.",
        ],
      },
      {
        heading: "Roles",
        paragraphs: [
          "Each collaborator has a role. A co-host or co-instructor presents: they see the attendee list and hold host controls during the session, and each plan has one such presenter. The other roles — moderator, guest speaker, technical support, teaching assistant, guest lecturer, and content creator — help deliver the session without those controls.",
        ],
      },
      {
        heading: "Revenue sharing",
        paragraphs: [
          "The host sets each collaborator's percentage when inviting them. Shares are taken from the expert portion of each sale, after the platform fee, and only collaborators who have accepted are paid. The host always keeps at least 10%, so collaborator shares on one plan can add up to 90% at most.",
        ],
      },
    ],
  },
  {
    slug: "document-reviews",
    category: "experts",
    title: "How do I review documents learners share with me?",
    excerpt:
      "The Documents page, review statuses, and sending a response document.",
    updated: "September 2026",
    contactCategory: "consultant",
    related: ["recordings/uploading-documents", "experts/booking-requests"],
    sections: [
      {
        heading: "Reviewing a document",
        paragraphs: [
          "Documents that learners attach to their sessions with you appear on your Documents page. Open one, add review notes, and set its status: Pending, In review, Approved, Rejected, or Needs revision. You can update several documents at once.",
        ],
      },
      {
        heading: "Sending a response",
        paragraphs: [
          "Use Upload Response to send back an annotated copy, written feedback, or extra material, up to 10 MB per file. The response is linked to the learner's document and shared on the same session.",
        ],
      },
    ],
  },

  // ─── For organizations ──────────────────────────────────────────────────
  {
    slug: "sponsor-vs-host",
    category: "organizations",
    title: "Sponsor vs host vs hybrid — which model fits us?",
    excerpt:
      "Buyer, provider, and hybrid roles; credit pools vs licensed seats.",
    updated: "September 2026",
    contactCategory: "enterprise",
    related: [
      "organizations/wallet-invoice-billing",
      "organizations/members-roles",
    ],
    sections: [
      {
        heading: "The three postures",
        paragraphs: [
          "Organisations can sponsor learning (fund members' bookings), host learning (provide experts and programs), or do both as a hybrid. Sponsors choose between credit pools (shared balance drawn down per booking) and licensed seats (named members with program access).",
        ],
      },
      {
        heading: "Choosing",
        paragraphs: [
          "Pick credit pools for flexible, pay-as-you-go teams and licensed seats for fixed cohorts with structured programs. Talk to sales for a walkthrough against your headcount and budget cycle.",
        ],
      },
    ],
  },
  {
    slug: "wallet-invoice-billing",
    category: "organizations",
    title: "How do org wallet, invoices, and overages work?",
    excerpt:
      "Wallet top-ups, invoice terms, low-balance and overdue alerts, overages.",
    updated: "September 2026",
    contactCategory: "enterprise",
    related: ["organizations/sponsor-vs-host", "payments/gst-invoices"],
    sections: [
      {
        heading: "Funding rails",
        paragraphs: [
          "Members can book against the organisation wallet, a program license, or an invoice arrangement depending on your contract. Admins get low-balance, overage-due, invoice-overdue, and payout-failed alerts — keep billing and escalation contacts current so notices reach the right people.",
        ],
      },
      {
        heading: "Overages and overdue invoices",
        paragraphs: [
          "Usage beyond the wallet or seat pack accrues as overage under your contract terms (some plans block overage bookings outright). Overdue invoices can pause sponsored bookings until settled — clear them promptly to avoid learner disruption.",
        ],
      },
    ],
  },
  {
    slug: "members-roles",
    category: "organizations",
    title: "How do invites, roles, and verification work?",
    excerpt:
      "Invite tokens, owner vs billing admin, and the verification lifecycle.",
    updated: "September 2026",
    contactCategory: "enterprise",
    related: ["organizations/sso-setup", "getting-started/sso-sign-in"],
    sections: [
      {
        heading: "Invites and roles",
        paragraphs: [
          "Admins invite members by email; recipients accept through the invite link to join the workspace. Owners manage everything, while billing admins handle invoices and payments only — they cannot change SSO settings or manage members.",
        ],
      },
      {
        heading: "Verification",
        paragraphs: [
          "New organisations pass verification before sponsoring at scale. If verification is rejected, the notice names what to fix — correct it and resubmit rather than creating a duplicate organisation.",
        ],
      },
    ],
  },
  {
    slug: "sso-setup",
    category: "organizations",
    title: "How do we set up OIDC SSO?",
    excerpt: "Domain claims and OIDC provider setup.",
    updated: "September 2026",
    contactCategory: "enterprise",
    related: ["organizations/members-roles", "getting-started/sso-sign-in"],
    sections: [
      {
        heading: "Setup path",
        paragraphs: [
          "Verify your email domain first — verified domains cannot be claimed by another organisation. Then configure your OIDC provider with the values from the admin console, enable JIT provisioning for automatic account creation, and test with a pilot group before enforcing SSO.",
        ],
      },
    ],
  },
  {
    slug: "org-support-retention",
    category: "organizations",
    title: "Org support queues, activity, and data retention",
    excerpt:
      "Sponsorship billing questions, admin visibility, recording and chat retention.",
    updated: "October 2026",
    contactCategory: "enterprise",
    related: [
      "organizations/wallet-invoice-billing",
      "recordings/recording-expiry",
    ],
    sections: [
      {
        heading: "Support and visibility",
        paragraphs: [
          "Booking issues tied to sponsored members route through dedicated queues (sponsorship billing, session concerns raised by admins) so your admins and our team see the same request. Admins can track program activity, assignments, and member bookings from the organisation workspace. Admins never see members' chat messages, even when our team reviews a sponsored session.",
        ],
      },
      {
        heading: "Retention knobs",
        paragraphs: [
          "Your plan sets recording retention (around 90 days by default) and chat retention (up to a year). Shorter windows reduce storage and compliance surface but give learners less time to revisit — choose deliberately and tell members where to save critical takeaways.",
        ],
      },
    ],
  },

  // ─── Notifications, privacy, security & getting help ────────────────────
  {
    slug: "notification-preferences",
    category: "help",
    title: "How do I control notifications?",
    excerpt:
      "In-app vs email, per-category switches, optional notifications, and what always arrives.",
    updated: "November 2026",
    contactCategory: "general",
    related: ["help/unsubscribe-cookies"],
    sections: [
      {
        heading: "Your preference panel",
        paragraphs: [
          "Open Settings › Notifications, or the Notification settings link at the foot of the bell. The Optional notifications switch (the master switch) pauses optional emails and every in-app notification; the category switches fine-tune each stream, and you only see the categories your account can receive. Organisation categories appear when you belong to an organisation, and experts also see email quiet hours for their planning reminders.",
        ],
      },
      {
        heading: "What always arrives",
        paragraphs: [
          "Some notices are required and ignore these switches. In the bell and by email: account, security, verification and moderation notices. By email only: payment receipts, and invitations or decisions you must act on. Booking updates, reminders, refunds, payouts, support replies and announcements are optional and follow your switches.",
        ],
      },
      {
        heading: "Organisation workspaces",
        paragraphs: [
          "A workspace operator uses the same panel, under Workspace settings › Notifications. Its In-app and Email switches are the only channel controls for that account; there is no separate workspace setting.",
        ],
      },
    ],
  },
  {
    slug: "unsubscribe-cookies",
    category: "help",
    title: "How do I unsubscribe or manage cookies?",
    excerpt:
      "Email unsubscribe, the newsletter and marketing consent, and why there is no cookie banner.",
    updated: "November 2026",
    contactCategory: "general",
    related: [
      "help/notification-preferences",
      "getting-started/age-consent-delete-data",
    ],
    sections: [
      {
        heading: "Unsubscribe",
        paragraphs: [
          "Every optional email carries an unsubscribe link. Confirming turns off optional emails for your account, such as booking updates, reminders and refunds; required emails like security notices and payment receipts still arrive, and in-app notifications are not affected. Changed your mind? The confirmation page has a Resubscribe button, and you can manage each category from notification preferences.",
        ],
      },
      {
        heading: "Newsletter and marketing emails",
        paragraphs: [
          "Marketing emails and the newsletter follow one choice: Marketing communications in Settings › Account › Data consent & privacy rights. Giving that consent subscribes your account's email address to the newsletter without a confirmation email; withdrawing it unsubscribes you. The unsubscribe link in a newsletter stops it at once and also withdraws that consent for your account. The notification settings have no separate marketing switch.",
        ],
      },
      {
        heading: "Cookies",
        paragraphs: [
          "Familiarise uses only essential cookies, the ones that keep you signed in, protect forms and complete checkout, so there is no cookie banner and nothing to switch on or off. No analytics or advertising script runs on the site. If one is ever added, we will ask for your consent before it runs.",
        ],
      },
    ],
  },
  {
    slug: "privacy-cookies-safety",
    category: "help",
    title: "How is my data used? How do I report someone?",
    excerpt:
      "Data sharing basics, reporting users or content, and ban appeals.",
    updated: "October 2026",
    contactCategory: "general",
    related: [
      "getting-started/age-consent-delete-data",
      "help/how-we-review-messages",
      "help/tickets-and-contact",
    ],
    sections: [
      {
        heading: "Data use",
        paragraphs: [
          "We process your data to run the marketplace — accounts, bookings, payments (via Razorpay), and video (via Stream) — as described in the Privacy Policy. Payment and video providers receive only what they need to complete their function.",
          'Chat is checked automatically for fraud and safety, and our support team may read a booking\'s chat when it is reported or has a support case. "How and why we review messages" explains when and how.',
        ],
      },
      {
        heading: "Reporting and appeals",
        paragraphs: [
          "Report abusive users, inappropriate content, or poor session conduct from the relevant page, use Report Message in chat, or contact support with links and timestamps. Banned or suspended accounts receive the reason by email; reply with counter-evidence to appeal. Do not open a duplicate account to evade a ban — it harms your appeal.",
        ],
      },
    ],
  },
  {
    slug: "how-we-review-messages",
    category: "help",
    title: "How and why we review messages",
    excerpt:
      "What we check automatically, when a person reads your messages, who can see what, and how to appeal.",
    updated: "October 2026",
    contactCategory: "general",
    related: ["help/report-a-problem", "help/privacy-cookies-safety"],
    sections: [
      {
        heading: "Why we review messages",
        paragraphs: [
          "In-app chat helps learners and experts plan and run sessions. We review messages only for a few named reasons: to stop fraud and scams, to keep payments on Familiarise, to keep people safe, to resolve problems that are reported to us, and when the law requires it. The Privacy Policy (section 3.6) and Terms (section 12) set this out formally.",
        ],
      },
      {
        heading: "What we check automatically",
        // counsel: automated scanning is described as "may" until it is switched on; confirm the wording once it ships.
        paragraphs: [
          'Our systems may scan chat for signs of trouble. If a message matches, you may see a reminder in the chat, such as "Pay only on Familiarise; you are protected only here." Before a booking is confirmed, we may block a message that shares contact details.',
          "An automated match never leads to a penalty by itself. A person on our team checks it first.",
        ],
        list: [
          "Signs of fraud or a scam, such as fake payment links.",
          "Requests to pay outside Familiarise (for example by UPI, bank transfer or another app).",
          "Phone numbers, email addresses, social media handles, UPI IDs or payment links shared before a booking.",
          "Safety risks such as threats or harassment.",
        ],
      },
      {
        heading: "When a person reads your messages",
        paragraphs: [
          "A member of the Familiarise support team reads a booking's chat only when someone reports a message or the booking, or when the booking has an open support case. They see that booking's chat only, and only for that case. In a group session, they see only the messages of the people involved in the report. Every access is linked to the case and logged.",
          "We may also disclose messages when Indian law requires it, for example under a valid court or government order.",
        ],
      },
      {
        heading: "Who can see what",
        paragraphs: [
          "Here is who can see your messages and recordings, and when.",
        ],
        list: [
          "People in the booking: they see the chat as usual.",
          "Familiarise support staff: only as described above, linked to a case and logged.",
          "Organisation admins (sponsored sessions): never your messages. They may see a record that our team reviewed a sponsored session.",
          "Recordings: support staff can see details such as date and length. Only a Familiarise administrator can play a recording, for a specific case or report, and every playback is logged.",
        ],
      },
      {
        heading: "When Familiarise Support joins a chat",
        paragraphs: [
          'If evidence in a case is overdue, or after a report of a safety risk, fraud or a scam, a staff member may join the booking chat as "Familiarise Support". Everyone in the chat sees a banner and a message when this happens. We never join silently. Support leaves automatically when the case is resolved.',
          "You don't have to reply in the chat. If we ask you for evidence and you don't respond by the deadline, we decide on the evidence we have.",
        ],
      },
      {
        heading: "How you're told",
        // counsel: confirm the scope of the safety/legal exception to post-decision notice.
        paragraphs: [
          "After a decision, we tell the people in the case that our team reviewed messages related to it. We may delay or skip this notice when telling you would put someone at risk, help a fraud continue, or break the law.",
        ],
      },
      {
        heading: "If you disagree",
        paragraphs: [
          'You can appeal a decision once, within 7 days, from your request page. You can also contact our Grievance Officer through the Grievance Redressal page (/grievance). "Report a problem and how decisions work" explains the full process.',
        ],
      },
    ],
  },
  {
    slug: "report-a-problem",
    category: "help",
    title: "Report a problem and how decisions work",
    excerpt:
      "Continue an existing request, reopen one that didn't work, answer evidence requests, and appeal a decision.",
    updated: "October 2026",
    contactCategory: "general",
    related: ["help/how-we-review-messages", "help/tickets-and-contact"],
    sections: [
      {
        heading: "Report a problem",
        paragraphs: [
          "Open the booking and choose Get help. Pick what went wrong and follow the steps. If we can't fix it straight away, this creates a request with a reference number, which you can follow on your request page. For problems not tied to a booking, use the support page in your dashboard.",
        ],
      },
      {
        heading: "Already have a request? Continue it",
        // counsel: "This didn't fix it" and the Continue prompt describe the request lifecycle shipping before launch; keep in sync with the product.
        paragraphs: [
          "Use New request only for a different, unrelated problem. Duplicate requests slow things down.",
        ],
        list: [
          "Continue: if you already have an open request about the same booking, add to it.",
          "This didn't fix it: within 14 days of a request being resolved, reopen the same request.",
          "Appeal: after a decision, appeal it once. A new request does not undo a decision.",
          "New request: only for a different problem.",
        ],
      },
      {
        heading: "Evidence requests",
        paragraphs: [
          "We may ask you, the other party or both for evidence, such as screenshots, documents or an explanation. Each request shows a deadline on your request page, usually 48 hours. If a party doesn't respond by the deadline, we decide on the evidence we have.",
        ],
        list: [
          "File types: PDF, JPEG, PNG, WebP, TXT and DOCX.",
          "Up to 20 MB per file.",
          "Up to 20 files per person per case.",
          "Never send OTPs, UPI PINs, card numbers or passwords.",
        ],
      },
      {
        heading: "How decisions work",
        paragraphs: [
          'A member of our support team reviews your request, the booking\'s records (such as join and leave times and payments) and any evidence. Where needed, they may read the booking chat, as explained in "How and why we review messages". We then record a decision and explain it to both sides.',
          "If the decision includes a refund, credit or make-up session, we carry it out through Familiarise under the Cancellation & Refund Policy. You don't need to arrange anything with the other party.",
        ],
      },
      {
        heading: "Appeals",
        paragraphs: [
          "You can appeal once, within 7 days of the decision, from your request page. Tell us what you think we got wrong and add anything new. If you're still unhappy after the appeal, you can contact our Grievance Officer through the Grievance Redressal page (/grievance). This doesn't affect your other legal rights.",
        ],
      },
      {
        heading: "Service complaints vs chargebacks",
        paragraphs: [
          "Reporting a problem with a booking is a service complaint. A payment dispute (chargeback) is when you ask your bank to reverse a charge. Report a problem first: it's usually faster, and a chargeback freezes the amount and pauses actions on the booking.",
        ],
      },
    ],
  },
  {
    slug: "tickets-and-contact",
    category: "help",
    title: "How do I contact support and track my support case?",
    excerpt:
      "Per-booking help vs general support cases, reference numbers, response times, and platform status.",
    updated: "October 2026",
    contactCategory: "general",
    related: ["help/report-a-problem", "help/privacy-cookies-safety"],
    sections: [
      {
        heading: "Pick the right channel",
        paragraphs: [
          "For a specific booking, use Get help on that appointment to report a problem — it opens a request with full booking context attached. For everything else, use Contact us (general, technical, billing, booking, expert, enterprise, feedback) or the in-dashboard support page. Enterprise and team-training inquiries route to the sales pipeline instead of the support queue.",
        ],
      },
      {
        heading: "References, response times, and status",
        paragraphs: [
          "Requests carry a reference number and target acknowledgement within 24 hours. Resolution follows the applicable category deadline; urgent content complaints have shorter deadlines. Waiting for a reply does not extend a statutory deadline. During incidents a banner describes the degradation; a full maintenance page auto-refreshes every 30 seconds — check it before opening a duplicate request.",
        ],
        list: [
          "Continue your open request instead of opening a new one.",
          "Attach screenshots, payment IDs, and timestamps up front.",
          "One problem per request resolves faster than bundled complaints.",
        ],
      },
    ],
  },
  {
    slug: "browser-support",
    category: "help",
    title: "Which browsers and devices work? Is there a mobile app?",
    excerpt:
      "Browser-only access today, responsive design, and why iOS push is unavailable.",
    updated: "September 2026",
    contactCategory: "technical",
    related: ["video/how-to-join", "help/notification-preferences"],
    sections: [
      {
        heading: "Browser support, no app yet",
        paragraphs: [
          "Familiarise runs in the browser — there is no mobile app or offline mode yet. Use a current Chrome, Edge, Firefox, or Safari on desktop or mobile; everything, including video sessions and checkout, is responsive. Because there is no installed app, iPhone push notifications are unavailable until native push launches.",
        ],
      },
      {
        heading: "If something looks broken",
        paragraphs: [
          "Update the browser, disable aggressive ad-blockers for the session domain, and allow camera and microphone for meetings. Going offline pauses live features rather than caching them — reconnect to resume.",
        ],
      },
    ],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────

export function getCategory(slug: string): SupportCategory | undefined {
  return supportCategories.find((c) => c.slug === slug);
}

export function getArticle(
  category: string,
  slug: string,
): SupportArticle | undefined {
  return supportArticles.find(
    (a) => a.category === category && a.slug === slug,
  );
}

export function articlesForCategory(category: string): SupportArticle[] {
  return supportArticles.filter((a) => a.category === category);
}

export function articleUrl(article: Pick<SupportArticle, "category" | "slug">) {
  return `/support/${article.category}/${article.slug}`;
}

/** Resolve `category/slug` related links, dropping stale entries silently. */
export function relatedArticles(article: SupportArticle): SupportArticle[] {
  const out: SupportArticle[] = [];
  for (const ref of article.related) {
    const [category, ...rest] = ref.split("/");
    const found = getArticle(category, rest.join("/"));
    if (found) out.push(found);
  }
  return out;
}

/** Synonym expansion so user language matches article language. */
const SYNONYMS: Record<string, string[]> = {
  refund: ["cancel", "cancellation", "money back", "reimburse"],
  cancel: ["refund", "cancellation"],
  upi: ["payment", "pay", "razorpay"],
  card: ["payment", "pay", "stripe"],
  payment: ["pay", "upi", "card", "razorpay", "stripe", "billing"],
  password: ["sign in", "login", "forgot"],
  login: ["sign in", "password"],
  sso: ["single sign-on", "saml", "oidc", "work email"],
  video: ["call", "meeting", "join", "camera", "mic"],
  recording: ["replay", "video", "record"],
  payout: ["earning", "bank", "tds", "money"],
  invoice: ["gst", "bill", "receipt", "credit note"],
  gst: ["invoice", "tax", "cgst", "sgst", "igst"],
  referral: ["credit", "discount", "coupon"],
  slot: ["time", "schedule", "availability", "calendar"],
  timezone: ["time zone", "time", "ist"],
  reschedule: ["postpone", "move", "change time"],
  notification: ["email", "alert", "remind", "push"],
  ticket: ["support", "help", "complaint", "contact", "request"],
  dispute: ["report a problem", "complaint", "chargeback"],
  complaint: ["report a problem", "request"],
  chat: ["message"],
  message: ["chat"],
  expert: ["consultant", "mentor", "coach"],
  organisation: ["organization", "org", "company", "enterprise", "team"],
  organization: ["organisation", "org", "company", "enterprise", "team"],
};

/** Latest change anywhere in the corpus; feeds every article's JSON-LD `dateModified`. */
export const CONTENT_ISO_DATE = "2026-10-21";

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/[^a-z0-9\s+]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Filler words that match everywhere and add no signal. */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "do",
  "does",
  "for",
  "how",
  "i",
  "is",
  "my",
  "of",
  "the",
  "to",
  "what",
  "why",
]);

function queryWords(query: string): string[] {
  return normalize(query).split(" ").filter(Boolean);
}

function expandQuery(query: string): string[] {
  const base = normalize(query);
  if (!base) return [];
  const terms = new Set<string>([base]);
  const words = new Set(queryWords(query));
  // Plural tolerance for synonym keys ("invoices" still fires the "invoice"
  // synonyms). Strips one trailing "s" only, so "discard" never fires "card".
  const singular = (w: string) => w.replace(/s$/, "");
  for (const [key, alts] of Object.entries(SYNONYMS)) {
    // Single-word keys match whole query words only ("card" must not fire on
    // "discard"); multi-word keys match as phrases.
    const hit = key.includes(" ")
      ? base.includes(key)
      : words.has(key) ||
        [...words].some((w) => w !== key && singular(w) === key);
    if (hit) {
      for (const alt of alts) terms.add(normalize(alt));
    }
  }
  // Also match significant individual words for multi-word queries.
  for (const word of words) {
    if (word.length > 2 && !STOPWORDS.has(word)) terms.add(word);
  }
  return [...terms];
}

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word/phrase match with a light plural tolerance ("refund" matches
 * "refunds"), so user language meets article language without substring
 * false positives.
 */
function hasTerm(haystack: string, term: string): boolean {
  const words = term.split(" ").filter(Boolean);
  if (words.length === 0) return false;
  const body = words.slice(0, -1).map(escapeRegExp).join("\\s+");
  const last = escapeRegExp(words[words.length - 1]);
  const pattern =
    words.length === 1
      ? `\\b${last}(?:es|s)?\\b`
      : `\\b${body}\\s+${last}(?:es|s)?\\b`;
  return new RegExp(pattern).test(haystack);
}

/**
 * Ranked in-memory search over the article corpus. Title matches outrank
 * excerpts, which outrank body text — mirroring the dashboard HelpPanel
 * model but across the full public corpus with word-boundary matching.
 */
export function searchSupport(query: string): SupportArticle[] {
  const q = normalize(query);
  if (!q) return [];
  const terms = expandQuery(q);
  const scored: { article: SupportArticle; score: number }[] = [];

  for (const article of supportArticles) {
    let score = 0;
    const title = normalize(article.title);
    const excerpt = normalize(article.excerpt);
    const categoryTitle = normalize(getCategory(article.category)?.title ?? "");
    const body = normalize(
      article.sections
        .map(
          (s) =>
            `${s.heading} ${s.paragraphs.join(" ")} ${(s.list ?? []).join(" ")}`,
        )
        .join(" "),
    );

    for (const term of terms) {
      if (!term) continue;
      if (hasTerm(title, term)) score += 3;
      if (hasTerm(excerpt, term)) score += 2;
      if (hasTerm(categoryTitle, term)) score += 1;
      if (hasTerm(body, term)) score += 1;
    }
    if (score > 0) scored.push({ article, score });
  }

  return scored
    .sort(
      (a, b) =>
        b.score - a.score || a.article.title.localeCompare(b.article.title),
    )
    .map((s) => s.article);
}

/** Markdown rendering of an article for the "Copy for LLM" button. */
export function articleToMarkdown(article: SupportArticle): string {
  const lines: string[] = [`# ${article.title}`, "", article.excerpt, ""];
  for (const section of article.sections) {
    lines.push(`## ${section.heading}`, "");
    for (const p of section.paragraphs) lines.push(p, "");
    if (section.list) {
      for (const item of section.list) lines.push(`- ${item}`);
      lines.push("");
    }
  }
  lines.push(
    `Source: Familiarise Help Center (${articleUrl(article)})`,
    "Policies: /refund, /pricing, /privacy, /terms",
  );
  return lines.join("\n");
}

/** The categories, with their articles, one dashboard audience sees (#1527). */
export function helpCenterFor(
  audience: HelpCenterAudience,
): { category: SupportCategory; articles: SupportArticle[] }[] {
  return HELP_CENTER_AUDIENCE_CATEGORIES[audience].flatMap((slug) => {
    const category = getCategory(slug);
    return category ? [{ category, articles: articlesForCategory(slug) }] : [];
  });
}

/** `category/slug` refs, most-asked first, for each dashboard audience (#1527). */
const SUGGESTED_ARTICLES: Record<HelpCenterAudience, readonly string[]> = {
  learner: [
    "booking/reschedule",
    "booking/cancel-and-no-show",
    "payments/refunds-explained",
    "video/how-to-join",
    "help/tickets-and-contact",
  ],
  expert: [
    "experts/booking-requests",
    "experts/payouts",
    "experts/create-offerings",
    "experts/availability-and-pricing",
    "help/tickets-and-contact",
  ],
};

/**
 * The Support requests page's suggested articles (#1527): drawn only from the
 * audience's own Help Center categories, so a learner never gets an expert
 * article.
 */
export function suggestedArticlesFor(
  audience: HelpCenterAudience,
): SupportArticle[] {
  const pool = helpCenterFor(audience).flatMap(({ articles }) => articles);
  return SUGGESTED_ARTICLES[audience].flatMap((ref) =>
    pool.filter((a) => `${a.category}/${a.slug}` === ref),
  );
}

/**
 * #1527 — three Help Center answers per support-case topic, for the case
 * composer's suggestions and the user's request page. `category/slug`
 * refs, most relevant first.
 */
const TOPIC_ARTICLES: Record<CaseTopic, readonly string[]> = {
  payments: [
    "payments/payment-methods-and-failures",
    "payments/deducted-but-unconfirmed",
    "payments/gst-invoices",
  ],
  cancellation: [
    "booking/cancel-and-no-show",
    "payments/refunds-explained",
    "booking/reschedule",
  ],
  scheduling: [
    "booking/reschedule",
    "booking/timezones",
    "booking/picking-slots",
  ],
  session: [
    "booking/cancel-and-no-show",
    "video/dropped-call",
    "experts/reviews-feedback",
  ],
  technical: ["video/join-errors", "video/how-to-join", "help/browser-support"],
  recordings: [
    "recordings/finding-recordings",
    "recordings/recording-expiry",
    "video/recording-consent",
  ],
  documents: [
    "recordings/uploading-documents",
    "recordings/class-materials",
    "experts/document-reviews",
  ],
  account: [
    "getting-started/sign-in-and-password",
    "getting-started/how-to-sign-up",
    "getting-started/age-consent-delete-data",
  ],
  organisation: [
    "organizations/org-support-retention",
    "organizations/wallet-invoice-billing",
    "organizations/members-roles",
  ],
  other: [
    "help/report-a-problem",
    "help/tickets-and-contact",
    "help/how-we-review-messages",
  ],
};

/** Every topic's article links; small enough to hand to a client whole. */
export function articleLinksByTopic(): Record<CaseTopic, ArticleLink[]> {
  const links = {} as Record<CaseTopic, ArticleLink[]>;
  for (const topic of CASE_TOPICS) {
    links[topic] = TOPIC_ARTICLES[topic].flatMap((ref) => {
      const [category, slug] = ref.split("/");
      const article = getArticle(category, slug);
      return article
        ? [{ title: article.title, href: articleUrl(article) }]
        : [];
    });
  }
  return links;
}

/** #1527 — every Help Center article as a link, for the composer's search. */
export function helpCenterArticleLinks(): ArticleLink[] {
  return supportArticles.map((a) => ({ title: a.title, href: articleUrl(a) }));
}
