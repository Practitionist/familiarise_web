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
      "Checkout failures, payment links, refunds, referral credits, GST invoices, and disputes.",
    icon: "payments",
    subcategories: [
      {
        title: "Paying",
        description: "Methods, failed payments, and expired payment links.",
      },
      {
        title: "Refunds",
        description: "Timelines, statuses, appeals, and non-refundable fees.",
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
      "Sponsorship models, wallet and invoice billing, members and roles, SSO/SCIM.",
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
        title: "SSO, SCIM & retention",
        description: "Identity setup, support, and data retention.",
      },
    ],
  },
  {
    slug: "help",
    title: "Notifications, privacy, security & getting help",
    description:
      "Notification preferences, quiet hours, cookies, safety, tickets, and contacting support.",
    icon: "help",
    subcategories: [
      {
        title: "Notifications",
        description: "Channels, categories, quiet hours, unsubscribe.",
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
      "organizations/sso-scim-setup",
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
        heading: "Refund tiers (see /refund for the binding policy)",
        paragraphs: [
          "Open the appointment and choose Cancel to see a live preview of your exact refund before confirming. Indicative tiers:",
        ],
        list: [
          "1-on-1: more than 24h before — 100%; 12–24h — 50%; under 12h — 0%.",
          "Webinar: more than 48h — 100%; 24–48h — 50%; under 24h — 0%.",
          "Class: 7-day / 3-day tiers plus first-week pro-rata terms on the policy page.",
          "Subscription: cancel anytime; the current period is not refunded, access continues till it ends.",
        ],
      },
      {
        heading: "No-shows",
        paragraphs: [
          "If the expert misses the session, the platform flags it after a grace window (around 2 hours) and the booking is cancelled with a refund for expert fault. If you miss the session, standard cancellation terms apply. Sessions held outside the platform are marked inconclusive and handled case by case — contact support with evidence.",
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
      "UPI, cards, netbanking, and wallets via Razorpay and Stripe — plus failure fixes.",
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
          "Checkout accepts UPI, credit and debit cards, netbanking, and wallets through Razorpay, with Stripe available for international cards. Prices are set by experts with the platform fee included in the displayed price, and INR is the default currency.",
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
      "7–14 day timeline, status meanings, appeals, and which fees are non-refundable.",
    updated: "September 2026",
    contactCategory: "billing",
    related: ["booking/cancel-and-no-show", "payments/gst-invoices"],
    sections: [
      {
        heading: "Timeline and destination",
        paragraphs: [
          "Refunds go only to the original payment method (UPI refunds return to the same UPI ID, card refunds to the same card). After approval, allow a review window plus bank processing — typically 7–14 days end to end. The platform fee and gateway fee are non-refundable; for example, a ₹1,000 booking may refund ₹850 after fees.",
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
          "Referrals reward both sides (for example ₹300 each, rising toward ₹500 in promotions). Credits apply automatically at checkout above the minimum order value (for example ₹500+), oldest-expiring first, and expire 90 days after they are issued. Credits are INR-only.",
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
    updated: "September 2026",
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
          "Always contact us before asking your bank to reverse a charge. A chargeback freezes the disputed amount on both sides, blocks further booking actions on the appointment while the dispute is live, and may lead to account suspension. Support resolves most billing disputes faster than banks do.",
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
    related: ["organizations/sso-scim-setup", "getting-started/sso-sign-in"],
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
    slug: "sso-scim-setup",
    category: "organizations",
    title: "How do we set up SAML/OIDC SSO and SCIM?",
    excerpt:
      "Domain claims, provider setup, certificate rotation, and expiry alerts.",
    updated: "September 2026",
    contactCategory: "enterprise",
    related: ["organizations/members-roles", "getting-started/sso-sign-in"],
    sections: [
      {
        heading: "Setup path",
        paragraphs: [
          "Verify your email domain first — verified domains cannot be claimed by another organisation. Then configure your SAML or OIDC provider with the values from the admin console, enable JIT provisioning or SCIM sync for automatic account creation, and test with a pilot group before enforcing SSO.",
        ],
      },
      {
        heading: "Certificates and alerts",
        paragraphs: [
          "SAML certificates expire. Admins receive expiry alerts ahead of time — rotate the certificate (re-paste the X.509 PEM) before it lapses, or sign-ins will fail. SCIM tokens and group mappings control who syncs; rotate tokens immediately if exposed.",
        ],
      },
    ],
  },
  {
    slug: "org-support-retention",
    category: "organizations",
    title: "Org support queues, activity, and data retention",
    excerpt:
      "Sponsorship billing disputes, admin visibility, recording and chat retention.",
    updated: "September 2026",
    contactCategory: "enterprise",
    related: [
      "organizations/wallet-invoice-billing",
      "recordings/recording-expiry",
    ],
    sections: [
      {
        heading: "Support and visibility",
        paragraphs: [
          "Booking issues tied to sponsored members route through dedicated queues (sponsorship billing, admin disputes) so your admins and our team see the same thread. Admins can track program activity, assignments, and member bookings from the organisation workspace.",
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
      "In-app vs email, per-category toggles, the master switch, and push status.",
    updated: "September 2026",
    contactCategory: "general",
    related: ["help/quiet-hours", "help/unsubscribe-cookies"],
    sections: [
      {
        heading: "Your preference panel",
        paragraphs: [
          "Open notification preferences from your inbox or settings. A master toggle pauses everything; per-category toggles (appointment reminders, payments, support updates, feedback, trials, subscriptions, marketing) fine-tune each stream, with extra organisation categories on sponsored accounts.",
        ],
      },
      {
        heading: "Push notifications",
        paragraphs: [
          "Native push is marked Coming soon and stays off until launch — keep email or in-app enabled for time-sensitive updates like payment failures and session reminders.",
        ],
      },
    ],
  },
  {
    slug: "quiet-hours",
    category: "help",
    title: "How do quiet hours work?",
    excerpt: "The 22:00–08:00 window, timezones, and which messages bypass it.",
    updated: "September 2026",
    contactCategory: "general",
    related: ["help/notification-preferences", "help/unsubscribe-cookies"],
    sections: [
      {
        heading: "The quiet window",
        paragraphs: [
          "Quiet hours default to 22:00–08:00 in your timezone. Non-urgent notifications arriving overnight are held and delivered in the morning instead of buzzing your inbox at night.",
        ],
      },
      {
        heading: "Urgent bypasses",
        paragraphs: [
          "Time-critical messages — payment failures, imminent session changes — bypass quiet hours because acting late costs money or misses the session. Marketing never bypasses.",
        ],
      },
    ],
  },
  {
    slug: "unsubscribe-cookies",
    category: "help",
    title: "How do I unsubscribe or manage cookies?",
    excerpt: "Email unsubscribe, cookie categories, and what stays essential.",
    updated: "September 2026",
    contactCategory: "general",
    related: [
      "help/notification-preferences",
      "getting-started/age-consent-delete-data",
    ],
    sections: [
      {
        heading: "Unsubscribe",
        paragraphs: [
          "Every marketing email carries an unsubscribe link that opts you out immediately; transactional emails (receipts, booking confirmations) continue because they are part of the service. You can also manage categories from notification preferences.",
        ],
      },
      {
        heading: "Cookies",
        paragraphs: [
          "The cookie banner offers essential, analytics, marketing, and functional toggles. Essential cookies stay on — the site cannot sign you in without them — while the rest are your choice and can be changed anytime.",
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
    updated: "September 2026",
    contactCategory: "general",
    related: [
      "getting-started/age-consent-delete-data",
      "help/tickets-and-contact",
    ],
    sections: [
      {
        heading: "Data use",
        paragraphs: [
          "We process your data to run the marketplace — accounts, bookings, payments (via Razorpay/Stripe), and video (via Stream) — as described in the Privacy Policy. Payment and video providers receive only what they need to complete their function.",
        ],
      },
      {
        heading: "Reporting and appeals",
        paragraphs: [
          "Report abusive users, inappropriate content, or poor session conduct from the relevant page or by contacting support with links and timestamps. Banned or suspended accounts receive the reason by email; reply with counter-evidence to appeal. Do not open a duplicate account to evade a ban — it harms your appeal.",
        ],
      },
    ],
  },
  {
    slug: "tickets-and-contact",
    category: "help",
    title: "How do I contact support and track my ticket?",
    excerpt:
      "Per-booking help vs tickets, reference numbers, SLAs, and platform status.",
    updated: "September 2026",
    contactCategory: "general",
    related: ["help/privacy-cookies-safety", "booking/cancel-and-no-show"],
    sections: [
      {
        heading: "Pick the right channel",
        paragraphs: [
          "For a specific booking, use the help option on that appointment — it opens a thread with full booking context attached. For everything else, use Contact us (general, technical, billing, booking, expert, enterprise, feedback) or the in-dashboard support page. Enterprise and team-training inquiries route to the sales pipeline instead of the support queue.",
        ],
      },
      {
        heading: "References, SLAs, and status",
        paragraphs: [
          "Tickets carry a speakable reference number and target acknowledgement within 24 hours with resolution within 15 days; complex cases pause the clock while we await your reply. During incidents a banner describes the degradation; a full maintenance page auto-refreshes every 30 seconds — check it before filing a duplicate ticket.",
        ],
        list: [
          "Include your ticket reference in every follow-up.",
          "Attach screenshots, payment IDs, and timestamps up front.",
          "One issue per ticket resolves faster than bundled complaints.",
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
  ticket: ["support", "help", "complaint", "contact"],
  expert: ["consultant", "mentor", "coach"],
  organisation: ["organization", "org", "company", "enterprise", "team"],
  organization: ["organisation", "org", "company", "enterprise", "team"],
};

/**
 * Machine-readable date for the v1 corpus. Every article currently carries the
 * same display month, so one constant feeds JSON-LD `dateModified`; per-article
 * ISO dates replace it once content starts changing on different dates.
 */
export const CONTENT_ISO_DATE = "2026-09-01";

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
  for (const [key, alts] of Object.entries(SYNONYMS)) {
    // Single-word keys match whole query words only ("card" must not fire on
    // "discard"); multi-word keys match as phrases.
    const hit = key.includes(" ") ? base.includes(key) : words.has(key);
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
