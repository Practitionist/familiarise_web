/**
 * In-app copy for every B2C workflow. Payload fields are documented on the
 * types in `../workflows`; unit-free names carry human values (`dateTime`,
 * `amountFormatted`), the suffixed twins carry raw ones.
 */

import { NOVU_WORKFLOWS as W } from "../workflows";
import type { WorkflowTemplate } from "./types";

/** `FAM-2026-000007 — Support for Basic Consultation`, or just the title. */
const TICKET =
  "{% if payload.reference %}{{payload.reference}} — {% endif %}{{payload.ticketTitle}}";

const CANCELLED_COUNT =
  "{% if payload.appointmentsCancelled > 0 %} {{payload.appointmentsCancelled}} upcoming appointment{% if payload.appointmentsCancelled != 1 %}s were{% else %} was{% endif %} cancelled.{% endif %}";

export const B2C_TEMPLATES: WorkflowTemplate[] = [
  // ── Appointments ────────────────────────────────────────────────────────
  {
    workflowId: W.APPOINTMENT_BOOKED,
    name: "Appointment booked",
    description: "Both parties, once a booking is confirmed.",
    category: "appointments",
    inApp: {
      subject: "Booking confirmed",
      body: "Your {{payload.appointmentType}} for {{payload.planTitle}} is booked{% if payload.dateTime %} for {{payload.dateTime}}{% endif %}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.APPOINTMENT_PARTIALLY_SCHEDULED,
    name: "Appointment partly scheduled",
    description:
      "Both parties, when only some of a programme's sessions fit the calendar.",
    category: "appointments",
    inApp: {
      subject: "Partly scheduled",
      body: "{{payload.placedSessions}} of {{payload.requiredSessions}} sessions for {{payload.planTitle}} are booked. The remaining {{payload.unplacedSessions}} will be scheduled as availability opens.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.APPOINTMENT_CANCELLED,
    name: "Appointment cancelled",
    description:
      "Both parties. `cancelledBy` is a name or a capitalised role; with `seatRemoved`, the attendee a host removed from a class or webinar that goes ahead; `removalNote` carries a conduct removal's reason and its support case.",
    category: "appointments",
    inApp: {
      subject:
        "{% if payload.seatRemoved %}Removed from {{payload.planTitle}}{% else %}Session cancelled{% endif %}",
      body: "{% if payload.seatRemoved %}{{payload.cancelledBy}} removed you from the {{payload.appointmentType}} {{payload.planTitle}}, so you no longer have a seat in it.{% if payload.removalNote %} {{payload.removalNote}}{% endif %}{% else %}{{payload.cancelledBy}} cancelled the {{payload.appointmentType}} for {{payload.planTitle}}{% if payload.dateTime %} on {{payload.dateTime}}{% endif %}. Reason: {{payload.reason}}.{% endif %}",
      redirect: "dashboardUrl",
    },
  },
  // #1780 row 4 — the class make-up machine; staged in the writer's transaction.
  {
    workflowId: W.CLASS_SESSION_CANCELLED,
    name: "Class session cancelled",
    description:
      "Seat holders, and the plan's team in a sentence of their own, when one session of a class is cancelled.",
    category: "appointments",
    inApp: {
      subject:
        "{% if payload.voided %}A class session did not count{% else %}A class session was cancelled{% endif %}",
      body: "{% if payload.forTeam %}The {{payload.dateTime}} session of {{payload.planTitle}} {% if payload.voided %}did not count as held{% else %}was cancelled{% endif %}.{% else %}{% if payload.voided %}Your {{payload.dateTime}} session of {{payload.planTitle}} lost too much time to count as held{% else %}Your {{payload.dateTime}} session of {{payload.planTitle}} was cancelled{% endif %} — {{payload.consultantName}} has until {{payload.makeUpBy}} to schedule a make-up, or that session is refunded automatically.{% endif %}",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.CLASS_MAKEUP_SCHEDULED,
    name: "Class make-up scheduled",
    description:
      "Seat holders, when the host schedules a cancelled session's make-up.",
    category: "appointments",
    inApp: {
      subject: "Make-up session scheduled",
      body: "The make-up session of {{payload.planTitle}} is on {{payload.dateTime}}.{% if payload.clash %} You already have a session then.{% endif %}{% if payload.leaveBy %} Keep your seat — nothing to do. Can't make it? Leave the class with a full refund of the sessions still to come until {{payload.leaveBy}}.{% endif %}",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.CLASS_SESSION_REFUNDED,
    name: "Class session refunded",
    description:
      "A seat holder, when a missed session was not made up in time.",
    category: "appointments",
    inApp: {
      subject: "Session refunded",
      body: "A missed session of {{payload.planTitle}} was not made up, so {% if payload.refundStarted %}your {{payload.amount}} refund has started and usually reaches you in 5–7 working days{% else %}{{payload.amount}} is on its way back to you{% endif %}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.CLASS_EXIT_AVAILABLE,
    name: "Class exit available",
    description:
      "A seat holder, when missed sessions (host cancellations and voided sessions) give them the right to leave with a full refund of the remaining sessions.",
    category: "appointments",
    inApp: {
      subject: "You can leave with a full refund",
      body: "{{payload.planTitle}} has had {{payload.misses}} missed session{% if payload.misses != 1 %}s{% endif %}. You may leave the series with a full refund of the sessions still to come.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.SESSION_NO_SHOW,
    name: "Session missed by the learner",
    description:
      "The learner of a 1:1 session who never joined it (#1569 D7); the session counts as held.",
    category: "appointments",
    inApp: {
      subject: "We didn't see you in your session",
      body: "Your {{payload.dateTime}} session of {{payload.planTitle}} went ahead without you, so it counts as held. If you couldn't get in, tell support and we will look at the call record.{% if payload.recordingUrl %} A recording is available in your dashboard.{% endif %}",
      redirect: "supportUrl",
    },
  },
  {
    workflowId: W.SESSION_MISSED_RECORDING,
    name: "Group session missed, recording available",
    description:
      "A class or webinar seat holder who was not in a held session, sent only when that session was recorded.",
    category: "appointments",
    inApp: {
      subject: "Sorry we missed you",
      body: "Sorry we missed you in the {{payload.dateTime}} session of {{payload.planTitle}} — here's the recording.",
      redirect: "recordingUrl",
    },
  },
  {
    // #1778 — notify-only: nothing is reserved, first to book wins.
    workflowId: W.WINDOW_OPENED,
    name: "Window opened",
    description: "A learner who asked to hear when a held 1:1 time frees up.",
    category: "appointments",
    inApp: {
      subject: "A time you wanted just opened",
      body: "{{payload.windowText}} with {{payload.consultantName}} is free again — first to book gets it.",
      redirect: "dashboardUrl",
    },
  },
  {
    // Notify-only: every waiter is told at once and the first to pay gets the seat.
    workflowId: W.EVENT_SEAT_OPENED,
    name: "Event seat opened",
    description:
      "Learners waiting on a sold-out webinar or class, when a seat frees.",
    category: "appointments",
    inApp: {
      subject: "A seat just opened",
      body: "A seat opened in {{payload.planTitle}}. It may already be gone; first come, first served.",
      redirect: "checkoutUrl",
    },
  },
  {
    workflowId: W.APPOINTMENT_RESCHEDULED,
    name: "Appointment rescheduled",
    description:
      "Both parties. `outcome` is MOVED (with `movesText` for a series), PROPOSED (with `respondBy`), RELEASED, DECLINED, WITHDRAWN or EXPIRED.",
    category: "appointments",
    inApp: {
      subject: "Schedule change",
      body: "{% if payload.outcome == 'MOVED' %}{% if payload.movesText %}{{payload.movedCount}} sessions of your {{payload.appointmentType}} for {{payload.planTitle}} moved: {{payload.movesText}}.{% else %}Your {{payload.appointmentType}} for {{payload.planTitle}} moved from {{payload.oldDateTime}} to {{payload.newDateTime}}.{% endif %}{% if payload.clash %} You already have a session then.{% endif %}{% if payload.leaveBy %} Keep your seat — nothing to do. Can't make it? Leave with a full refund until {{payload.leaveBy}}.{% endif %}{% elsif payload.outcome == 'PROPOSED' %}A new time was proposed for your {{payload.appointmentType}} for {{payload.planTitle}}: {{payload.newDateTime}} instead of {{payload.oldDateTime}}. Please review it{% if payload.respondBy %} by {{payload.respondBy}}, or the original time stands{% endif %}.{% elsif payload.outcome == 'RELEASED' %}The {{payload.appointmentType}} for {{payload.planTitle}}{% if payload.oldDateTime %} on {{payload.oldDateTime}}{% endif %} was released. You will be told once a new time is set.{% elsif payload.outcome == 'DECLINED' %}The proposed new time for your {{payload.appointmentType}} for {{payload.planTitle}} was declined{% if payload.oldDateTime %}; it stays on {{payload.oldDateTime}}{% endif %}.{% elsif payload.outcome == 'EXPIRED' %}The proposed new time for your {{payload.appointmentType}} for {{payload.planTitle}} expired, so your original time stands{% if payload.oldDateTime %}: {{payload.oldDateTime}}{% endif %}.{% else %}The proposed new time for your {{payload.appointmentType}} for {{payload.planTitle}} was withdrawn, so your original time stands{% if payload.oldDateTime %}: {{payload.oldDateTime}}{% endif %}.{% endif %}",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.APPOINTMENT_REMINDER,
    name: "Appointment reminder",
    description: "Both parties, ahead of the start time.",
    category: "appointments",
    inApp: {
      subject: "Coming up",
      body: "Your {{payload.appointmentType}} for {{payload.planTitle}} is coming up — {{payload.dateTime}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.SESSION_HOST_LIVE,
    name: "Host is live",
    description:
      "Paid seats, once per session, when the host first joins it through the app.",
    category: "appointments",
    inApp: {
      subject: "Your host is live",
      body: "{{payload.consultantName}} has joined your {{payload.appointmentType}} for {{payload.planTitle}}. Join now.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.APPOINTMENT_COMPLETED,
    name: "Appointment completed",
    description: "Both parties, when the auto-complete sweep closes a session.",
    category: "appointments",
    inApp: {
      subject: "Session complete",
      body: "Your {{payload.appointmentType}} for {{payload.planTitle}} has ended. Open it to rate the session or find the recording.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.CHAT_UNREAD_DIGEST,
    name: "Unread chat messages",
    description:
      "One digest per user per 30-minute window from Stream's unread reminder. Never quotes message text.",
    category: "appointments",
    inApp: {
      subject: "Unread messages",
      body: "{{payload.summary}}",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.NEW_BOOKING_REQUEST,
    name: "New booking request",
    description:
      "The consultant, when a request needs their approval; with `expiresAt`, a request 6 hours from lapsing unanswered; with `nudgeHours`, a paid plan still waiting for session times (with `refundAt`, when the buyer is refunded); with `weekSummary`, the daily reminder for plan weeks with sessions still to place.",
    category: "appointments",
    inApp: {
      subject:
        "{% if payload.weekSummary %}Sessions to schedule this week{% elsif payload.expiresAt %}A request is about to lapse{% elsif payload.nudgeHours %}Waiting for session times{% else %}New booking request{% endif %}",
      body: "{% if payload.weekSummary %}{{payload.weekSummary}} Open it to auto-schedule in one tap.{% elsif payload.expiresAt %}{{payload.consulteeName}}'s request for {{payload.planTitle}} lapses at {{payload.expiresAt}} unless you approve or decline it.{% elsif payload.nudgeHours %}{{payload.consulteeName}}'s {{payload.appointmentType}} for {{payload.planTitle}} is waiting for session times — {{payload.nudgeHours}}h since payment. Schedule cycle 1 {% if payload.refundAt %}by {{payload.refundAt}}{% else %}within 48h{% endif %} or {{payload.consulteeName}} is refunded in full.{% else %}{{payload.consulteeName}} requested a {{payload.appointmentType}} for {{payload.planTitle}}{% if payload.requestedDateTime %} on {{payload.requestedDateTime}}{% endif %}.{% endif %}",
      redirect: "dashboardUrl",
    },
  },

  // ── Money ───────────────────────────────────────────────────────────────
  {
    workflowId: W.PAYMENT_LINK,
    name: "Payment due",
    description:
      "The consultee, when an approved booking awaits payment or is nudged.",
    category: "payments",
    inApp: {
      subject:
        "{% if payload.reminder %}Reminder: payment due{% else %}Payment required{% endif %}",
      body: "{% if payload.reminder %}Reminder: {{payload.amountFormatted}} is still due{% else %}{{payload.amountFormatted}} is due{% endif %} to confirm your {{payload.appointmentType}}{% if payload.planTitle %} for {{payload.planTitle}}{% endif %} with {{payload.consultantName}}{% if payload.expiresAt %} (pay by {{payload.expiresAt}}){% endif %}.",
      redirect: "paymentUrl",
    },
  },
  {
    workflowId: W.PAYMENT_SUCCESS,
    name: "Payment received",
    description: "The payer, on capture.",
    category: "payments",
    inApp: {
      subject: "Payment received",
      body: "Payment of {{payload.amountFormatted}} received for {{payload.planTitle}} with {{payload.consultantName}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.PAYMENT_FAILED,
    name: "Payment failed",
    description: "The payer. `failureReason` is a sentence.",
    category: "payments",
    inApp: {
      subject: "Payment failed",
      body: "Your payment of {{payload.amountFormatted}}{% if payload.planTitle %} for {{payload.planTitle}}{% endif %} did not go through{% if payload.failureReason %}: {{payload.failureReason}}{% endif %}.",
      redirect: "retryUrl",
    },
  },
  {
    workflowId: W.REFUND_REQUESTED,
    name: "Refund requested",
    description: "The consultant and ops, when a refund is raised.",
    category: "payments",
    inApp: {
      subject: "Refund requested",
      body: "A refund of {{payload.amountFormatted}} was requested{% if payload.consultantName %} for a session with {{payload.consultantName}}{% endif %}.{% if payload.reason %} Reason: {{payload.reason}}.{% endif %}",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.REFUND_PROCESSED,
    name: "Refund processed",
    description: "The payer, once the gateway confirms the refund.",
    category: "payments",
    inApp: {
      subject: "Refund on its way",
      body: "Your refund of {{payload.amountFormatted}}{% if payload.consultantName %} for the session with {{payload.consultantName}}{% endif %} has been processed. Banks usually post it within 5–7 working days.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.REFUND_FAILED,
    name: "Refund failed",
    description: "The payer, when the gateway rejects a refund (#779).",
    category: "payments",
    inApp: {
      subject: "Refund needs attention",
      body: "The refund of {{payload.amountFormatted}} could not be completed. Our team will retry it — please contact support if it has not arrived in a few days.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.PAYOUT_PROCESSED,
    name: "Payout sent",
    description: "The consultant, when a payout leaves for their bank.",
    category: "payments",
    inApp: {
      subject: "Payout sent",
      body: "A payout of {{payload.amount}} has been sent to your bank account.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.PAYOUT_FAILED,
    name: "Payout failed",
    description:
      "The consultant, when a payout fails or is reversed (earnings return to READY for the next batch).",
    category: "payments",
    inApp: {
      subject:
        "{% if payload.kind == 'REVERSED' %}Payout reversed{% else %}Payout needs attention{% endif %}",
      body: "{% if payload.kind == 'REVERSED' %}Your payout of {{payload.amount}} was reversed by the bank.{% else %}Your payout of {{payload.amount}} could not be completed.{% endif %} The earnings are back in your balance for the next payout run.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.PAYOUT_CLAWBACK,
    name: "Payout adjustment",
    description:
      "The consultant, when a refund or chargeback after a payout raises what they owe back, or a payout deducts, releases or cancels it.",
    category: "payments",
    inApp: {
      subject:
        "{% if payload.eventKind == 'RAISED' %}Payout adjustment{% elsif payload.eventKind == 'OFFSET_RESERVED' %}Adjustment deducted{% elsif payload.eventKind == 'OFFSET_RELEASED' %}Deduction released{% else %}Adjustment cancelled{% endif %}",
      body: "{% if payload.eventKind == 'RAISED' %}A booking paid out earlier was refunded or lost to a chargeback, so {{payload.amount}} is owed back. It will be deducted from your next payouts; nothing is taken from a bank account.{% elsif payload.eventKind == 'OFFSET_RESERVED' %}{{payload.amount}} owed from an earlier adjustment is being deducted from a payout being prepared. If that payout does not complete, the deduction is released.{% elsif payload.eventKind == 'OFFSET_RELEASED' %}A payout did not complete, so its {{payload.amount}} deduction was released. The amount is still owed and comes off a later payout.{% else %}The bank returned a payout, so {{payload.amount}} still owed against it was cancelled to avoid deducting it twice.{% endif %}",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.DISPUTE_CREATED,
    name: "Dispute opened",
    description: "The consultant and ops, when a chargeback is raised.",
    category: "payments",
    inApp: {
      subject: "Payment dispute",
      body: "A payment dispute of {{payload.amount}} was opened{% if payload.consulteeName %} by {{payload.consulteeName}}{% endif %}{% if payload.reason %}: {{payload.reason}}{% endif %}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.DISPUTE_UPDATED,
    name: "Dispute updated",
    description: "Ops reminder when a chargeback response deadline approaches.",
    category: "payments",
    inApp: {
      subject: "Dispute deadline reminder",
      body: "{% if payload.title %}{{payload.title}}{% else %}A payment dispute of {{payload.amount}} needs attention{% endif %}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.DISPUTE_RESOLVED,
    name: "Dispute resolved",
    description: "The consultant and ops, when the gateway closes a dispute.",
    category: "payments",
    inApp: {
      subject: "Dispute resolved",
      body: "The dispute of {{payload.amount}} has been resolved{% if payload.status %} — {{payload.status | downcase | replace: '_', ' '}}{% endif %}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.REFERRAL_BONUS_EARNED,
    name: "Referral bonus earned",
    description: "The referrer, after an eligible referral reward vests.",
    category: "payments",
    inApp: {
      subject: "Referral bonus",
      body: "{{payload.refereeName}} qualified through your referral link — {{payload.bonusAmount}} in credits has been added to your account.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.REFEREE_WELCOME_BONUS,
    name: "Welcome discount",
    description:
      "The new user who signed up through a referral, with the first-booking discount cap.",
    category: "payments",
    inApp: {
      subject: "Welcome discount",
      body: "Through {{payload.referrerName}}'s referral, you may qualify for a first-booking discount of up to {{payload.bonusAmount}}. Checkout shows the exact discount.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.REFERRAL_CREDITS_APPLIED,
    name: "Credits applied",
    description: "The payer, when a confirmed booking used referral credits.",
    category: "payments",
    inApp: {
      subject: "Credits applied",
      body: "{{payload.creditsUsed}} in referral credits was applied to your {{payload.appointmentType}}. {{payload.remainingCredits}} remains.",
      redirect: "dashboardUrl",
    },
  },

  // ── Subscriptions & trials ──────────────────────────────────────────────
  {
    workflowId: W.SUBSCRIPTION_STARTED,
    name: "Subscription started",
    description: "The consultee, once the subscription is approved and paid.",
    category: "subscriptions",
    inApp: {
      subject: "Subscription active",
      body: "Your subscription to {{payload.planTitle}} with {{payload.consultantName}} is now active.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.SUBSCRIPTION_CANCELLED,
    name: "Subscription cancelled",
    description: "Both parties.",
    category: "subscriptions",
    inApp: {
      subject: "Subscription cancelled",
      body: "The subscription to {{payload.planTitle}} has been cancelled.",
      redirect: "dashboardUrl",
    },
  },
  {
    // #1766 — re-bodied: the id stays (20-workflow cap) but the event is now
    // "your cycle is done and the next one is coming", not a renewal charge.
    workflowId: W.SUBSCRIPTION_RENEWED,
    name: "Subscription cycle done",
    description:
      "The consultee, when the last live session of a cycle completes with entitlement left.",
    category: "subscriptions",
    inApp: {
      subject: "Next sessions coming",
      body: "Your latest {{payload.planTitle}} sessions are done — {{payload.consultantName}} will schedule your next {% if payload.nextBatch == 1 %}session{% else %}{{payload.nextBatch}} sessions{% endif %} ({{payload.remainingSessions}} left).",
      redirect: "dashboardUrl",
    },
  },
  {
    // #1775 C-6 — staged inside the 48 h sweep's CAS transaction.
    workflowId: W.SUBSCRIPTION_UNALLOCATED_REFUNDED,
    name: "Plan refunded — not scheduled",
    description:
      "Both parties, when a paid plan's first cycle was not scheduled within 48 h of payment.",
    category: "subscriptions",
    inApp: {
      subject: "Plan refunded in full",
      body: "{{payload.planTitle}} was not scheduled within 48 h of payment, so {{payload.consulteeName}} is refunded in full.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.TRIAL_SESSION_SCHEDULED,
    name: "Trial scheduled",
    description: "Both parties, once the trial is confirmed.",
    category: "trials",
    inApp: {
      subject: "Trial scheduled",
      body: "The trial session for {{payload.planTitle}} between {{payload.consulteeName}} and {{payload.consultantName}} is scheduled for {{payload.dateTime}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.TRIAL_SESSION_COMPLETED,
    name: "Trial completed",
    description:
      "Both parties; the learner's copy carries `continueWith` and opens the plan.",
    category: "trials",
    inApp: {
      subject:
        "{% if payload.continueWith %}Continue with {{payload.continueWith}}{% else %}Trial complete{% endif %}",
      body: "The trial session for {{payload.planTitle}} with {% if payload.continueWith %}{{payload.continueWith}} has ended. Pick a plan to keep working together.{% else %}{{payload.consulteeName}} has ended.{% endif %}",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.TRIAL_SESSION_CANCELLED,
    name: "Trial cancelled",
    description: "Both parties.",
    category: "trials",
    inApp: {
      subject: "Trial cancelled",
      body: "The trial session for {{payload.planTitle}}{% if payload.dateTime %} on {{payload.dateTime}}{% endif %} was cancelled.",
      redirect: "dashboardUrl",
    },
  },
  {
    // Staged when the expert cancels a paid trial and it is refunded in full.
    workflowId: W.TRIAL_REFUNDED,
    name: "Trial refunded",
    description:
      "The learner, when the expert cancels a paid trial and its money moved.",
    category: "trials",
    inApp: {
      subject:
        "{% if payload.refundStarted %}Trial refund started{% else %}Trial refunded in full{% endif %}",
      body: "{% if payload.refundStarted %}{{payload.consultantName}} couldn't take your {{payload.planTitle}} trial. Your {{payload.amount}} refund has started and usually reaches you in 5–7 working days.{% else %}{{payload.consultantName}} couldn't take your {{payload.planTitle}} trial, so it is refunded in full.{% endif %}",
      redirect: "dashboardUrl",
    },
  },

  // ── Support ─────────────────────────────────────────────────────────────
  {
    workflowId: W.SUPPORT_TICKET_CREATED,
    name: "Support ticket opened",
    description: "Ops, when a support case lands in the queue.",
    category: "support",
    inApp: {
      subject: "New support case",
      body: `{{payload.userName | default: 'A customer'}} opened ${TICKET}.`,
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.SUPPORT_TICKET_RECEIVED,
    name: "Support ticket received",
    description:
      "The requester, confirming support case intake and expected response window.",
    category: "support",
    inApp: {
      subject: "Support case received",
      body: `We received ${TICKET}. Expected response within {{payload.slaWindow | default: '24 hours'}}.`,
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.SUPPORT_TICKET_ACTIVITY,
    name: "Support ticket activity",
    description:
      "Ops (the assignee, else everyone), when the customer replies or reopens.",
    category: "support",
    inApp: {
      subject: "Support case activity",
      body: `{{payload.userName | default: 'The customer'}} {{payload.activity | default: 'replied'}} on ${TICKET}.`,
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.SUPPORT_TICKET_UPDATE,
    name: "Support ticket status",
    description: "The support case's owner, when ops changes its status.",
    category: "support",
    inApp: {
      subject: "Support case updated",
      body: `Your support case ${TICKET} is now {{payload.status}}.`,
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.SUPPORT_TICKET_RESPONSE,
    name: "Support ticket reply",
    description: "The support case's owner, when ops replies.",
    category: "support",
    inApp: {
      subject: "Reply from support",
      body: `{{payload.respondedBy | default: 'Support'}} replied on ${TICKET}{% if payload.message %}: "{{payload.message | truncate: 140}}"{% endif %}`,
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.FEEDBACK_RECEIVED,
    name: "Feedback received",
    description: "Admins, when a user sends product feedback.",
    category: "feedback",
    inApp: {
      subject: "New feedback",
      body: '{{payload.userName}} sent feedback{% if payload.category %} ({{payload.category}}){% endif %}: "{{payload.message | truncate: 140}}"',
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.MODERATION_REPORT_OUTCOME,
    name: "Moderation report outcome",
    description: "The reporter, when moderation concludes a review.",
    category: "feedback",
    inApp: {
      subject: "Report update",
      body: "Your report {{payload.reference}} is now {{payload.outcome}}{% if payload.reason %}: {{payload.reason}}{% endif %}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.REVIEW_EXCLUDED_FROM_RATING,
    name: "Review not counted",
    description:
      "The expert, when moderation excludes a client review from their rating.",
    category: "feedback",
    inApp: {
      subject: "A review no longer counts toward your rating",
      body: "A client review on your profile is now marked 'Not counted in rating'. It stays visible but no longer affects your score.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.PLATFORM_FEEDBACK_UPDATE,
    name: "Feedback status updated",
    description: "The submitter, when product feedback changes status.",
    category: "feedback",
    inApp: {
      subject: "Feedback update",
      body: "Your feedback is now {{payload.status}}{% if payload.message %}: {{payload.message}}{% endif %}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.NEW_REVIEW_RECEIVED,
    name: "New review",
    description: "The consultant, when a review is published.",
    category: "feedback",
    inApp: {
      subject: "New review",
      body: '{{payload.reviewerName}} left a {{payload.rating}}-star review{% if payload.planTitle %} on {{payload.planTitle}}{% endif %}{% if payload.comment %}: "{{payload.comment | truncate: 140}}"{% endif %}',
      redirect: "dashboardUrl",
    },
  },

  // ── Account & moderation (no opt-out) ───────────────────────────────────
  {
    workflowId: W.VERIFICATION_STATUS_CHANGED,
    name: "Verification status",
    description:
      "The consultant. `status` is VERIFIED, REJECTED or NEEDS_INFO (a request for more information).",
    category: null,
    required: true,
    inApp: {
      subject: "Verification update",
      body: "{% case payload.status %}{% when 'VERIFIED' %}Your profile is verified and now visible to clients.{% when 'REJECTED' %}Your profile verification was not approved.{% when 'NEEDS_INFO' %}The reviewer needs more information before your profile can be verified.{% else %}Your profile verification is pending review.{% endcase %}{% if payload.reason %} {{payload.reason}}{% endif %}",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.NEW_CONSULTANT_APPLICATION,
    name: "Expert application",
    description: "Admins, when someone applies to become an expert.",
    category: null,
    required: true,
    inApp: {
      subject: "New expert application",
      body: "{{payload.applicantName | default: 'An applicant'}}{% if payload.applicantEmail %} ({{payload.applicantEmail}}){% endif %} applied to become an expert.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.MODERATION_WARNING,
    name: "Moderation warning",
    description: "The reported user, after a staff warning (#693).",
    category: null,
    required: true,
    inApp: {
      subject: "Warning",
      body: "You have received a warning from our moderation team{% if payload.reason %}: {{payload.reason}}{% endif %}. Further reports may lead to suspension.",
      redirect: "supportUrl",
    },
  },
  {
    workflowId: W.ACCOUNT_SECURITY_NOTICE,
    name: "Account security notice",
    description:
      "Mandatory account security notices for signup welcome, password changes, linked accounts, two-factor updates and account reinstatement.",
    category: null,
    required: true,
    inApp: {
      subject:
        "{% case payload.kind %}{% when 'WELCOME' %}Welcome to Familiarise{% when 'PASSWORD_CHANGED' %}Password changed{% when 'ACCOUNT_LINKED' %}Account linked{% when 'TWO_FACTOR_ENABLED' %}Two-factor authentication enabled{% when 'TWO_FACTOR_DISABLED' %}Two-factor authentication turned off{% when 'PASSKEY_ADDED' %}Passkey added{% when 'PASSKEY_REMOVED' %}Passkey removed{% when 'SECURITY_UPDATE' %}Account security update{% when 'ACCOUNT_REINSTATED' %}Account reinstated{% else %}Account security update{% endcase %}",
      body: "{% case payload.kind %}{% when 'WELCOME' %}Welcome to Familiarise! Open your dashboard to explore experts and upcoming sessions.{% when 'PASSWORD_CHANGED' %}Your account password was changed. If this was not you, reset your password right away.{% when 'ACCOUNT_LINKED' %}Your account is now linked with {{payload.provider | default: 'a sign-in provider'}}.{% when 'TWO_FACTOR_ENABLED' %}Two-factor authentication is now enabled on your account.{% when 'TWO_FACTOR_DISABLED' %}Two-factor authentication was turned off on your account.{% when 'PASSKEY_ADDED' %}A passkey was added to your account.{% when 'PASSKEY_REMOVED' %}A passkey was removed from your account.{% when 'SECURITY_UPDATE' %}{{payload.message | default: 'Your account security settings were updated.'}}{% when 'ACCOUNT_REINSTATED' %}Your account access has been restored{% if payload.reason %}: {{payload.reason}}{% endif %}.{% else %}Your account security settings were updated.{% endcase %}",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.CONTENT_REMOVED_NOTICE,
    name: "Content removed",
    description: "The author, when moderation removes their content.",
    category: null,
    required: true,
    inApp: {
      subject: "Your content was removed",
      body: "Your content was removed because it did not align with our community guidelines{% if payload.reason %}: {{payload.reason}}{% endif %}.",
      redirect: "supportUrl",
    },
  },
  {
    workflowId: W.ACCOUNT_SUSPENDED,
    name: "Account suspended",
    description: "The suspended user.",
    category: null,
    required: true,
    inApp: {
      subject: "Account suspended",
      body: `Your account is suspended until {{payload.suspendedUntil}}{% if payload.reason %}. Reason: {{payload.reason}}{% endif %}.${CANCELLED_COUNT}`,
      redirect: "supportUrl",
    },
  },
  {
    workflowId: W.ACCOUNT_BANNED,
    name: "Account closed",
    description: "The banned user.",
    category: null,
    required: true,
    inApp: {
      subject: "Account closed",
      body: `Your account has been permanently closed{% if payload.reason %}. Reason: {{payload.reason}}{% endif %}.${CANCELLED_COUNT}`,
      redirect: "supportUrl",
    },
  },
  {
    workflowId: W.GENERAL_ANNOUNCEMENT,
    name: "Announcement",
    description: "Everyone. Admin-authored title and body.",
    category: null,
    inApp: {
      subject: "{{payload.title}}",
      body: "{{payload.content}}",
      redirect: "linkUrl",
    },
  },
  {
    workflowId: W.COMPLIANCE_DEADLINE_ALERT,
    name: "Compliance deadline alert",
    description:
      "Platform admins and operators ahead of a statutory compliance filing or action.",
    category: null,
    required: true,
    inApp: {
      subject: "Compliance deadline approaching",
      body: "{{payload.title | default: 'A statutory compliance obligation'}} is due{% if payload.dueDate %} on {{payload.dueDate}}{% endif %}{% if payload.orgName %} for {{payload.orgName}}{% endif %}.",
      redirect: "dashboardUrl",
    },
  },

  // ── Session recordings & documents ──────────────────────────────────────────────
  {
    workflowId: W.RECORDING_AVAILABLE,
    name: "Recording ready",
    description: "Both parties, once a recording is published.",
    category: "appointments",
    inApp: {
      subject: "Recording ready",
      body: "A recording from your {{payload.appointmentType}} is ready to watch.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.RECORDING_FAILED,
    name: "Recording failed",
    description: "The host, when Stream could not save a recording.",
    category: "appointments",
    inApp: {
      subject: "Recording failed",
      body: "A recording could not be saved. The call itself was not affected.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.RECORDING_REMOVED,
    name: "Recording removed",
    description: "Attendees, when the expert deletes a session recording.",
    category: "appointments",
    inApp: {
      subject: "Recording removed",
      body: '{{payload.consultantName}} removed the recording "{{payload.recordingTitle}}" from your session.',
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.DOCUMENT_UPLOADED,
    name: "Document shared",
    description: "The other party, when a document is uploaded to a booking.",
    category: "appointments",
    inApp: {
      subject: "Document shared",
      body: "{% if payload.uploadedByRole == 'CONSULTEE' %}{{payload.consulteeName}}{% else %}{{payload.consultantName}}{% endif %} shared {{payload.fileName}}{% if payload.versionNo > 1 %} (version {{payload.versionNo}}){% endif %}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.DOCUMENT_REVIEWED,
    name: "Document reviewed",
    description: "The uploader, when the consultant records a decision.",
    category: "appointments",
    inApp: {
      subject: "Document reviewed",
      body: `{{payload.consultantName}} {% case payload.reviewStatus %}{% when 'APPROVED' %}approved{% when 'REJECTED' %}declined{% when 'NEEDS_REVISION' %}requested revisions on{% when 'IN_REVIEW' %}is reviewing{% else %}updated{% endcase %} {{payload.originalName}}.{% if payload.reviewNotes %} "{{payload.reviewNotes | truncate: 140}}"{% endif %}`,
      redirect: "dashboardUrl",
    },
  },

  // ── Collaborators ───────────────────────────────────────────────────────
  {
    workflowId: W.COLLABORATOR_INVITED,
    name: "Collaborator invited",
    description: "The invited consultant.",
    category: "appointments",
    inApp: {
      subject: "Collaboration invite",
      body: "{% if payload.ownerName %}{{payload.ownerName}} invited you{% else %}You are invited{% endif %} to join {{payload.planTitle}} ({{payload.planType | downcase}}) as {{payload.role | downcase | replace: '_', ' '}} with a {{payload.revenueSharePercentage}}% revenue share.{% if payload.expiresOn %} Respond by {{payload.expiresOn}}.{% endif %}",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.COLLABORATOR_TERMS_CHANGED,
    name: "Collaborator invitation terms changed",
    description: "The invited consultant, when a pending invitation is edited.",
    category: "appointments",
    inApp: {
      subject: "Invitation terms changed",
      body: "Your invitation to {{payload.planTitle}} now reads {{payload.role | downcase | replace: '_', ' '}} with a {{payload.revenueSharePercentage}}% revenue share.{% if payload.expiresOn %} Respond by {{payload.expiresOn}}.{% endif %}",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.COLLABORATOR_INVITE_EXPIRING,
    name: "Collaborator invite expiring",
    description: "The invited consultant, once, before the invitation lapses.",
    category: "appointments",
    inApp: {
      subject: "Invitation lapses soon",
      body: "Your invitation to {{payload.planTitle}} as {{payload.role | downcase | replace: '_', ' '}} lapses{% if payload.expiresOn %} on {{payload.expiresOn}}{% else %} soon{% endif %}. Accept or decline before then.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.COLLABORATOR_ACCEPTED,
    name: "Collaborator accepted",
    description: "The plan's host side.",
    category: "appointments",
    inApp: {
      subject: "Invite accepted",
      body: "{{payload.collaboratorName}} accepted your invitation to {{payload.planTitle}} as {{payload.role | downcase | replace: '_', ' '}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.COLLABORATOR_REMOVED,
    name: "Collaborator removed",
    description:
      "The consultant whose invitation was withdrawn or whose place on the team was ended.",
    category: "appointments",
    inApp: {
      subject:
        "{% if payload.pendingInvite %}Invitation withdrawn{% else %}Removed from a plan{% endif %}",
      body: "{% if payload.pendingInvite %}Your invitation to {{payload.planTitle}} ({{payload.planType | downcase}}) was withdrawn{% if payload.ownerName %} by {{payload.ownerName}}{% endif %}.{% else %}You are no longer a collaborator on {{payload.planTitle}} ({{payload.planType | downcase}}).{% endif %}",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.COLLABORATOR_DECLINED,
    name: "Collaborator declined",
    description: "The plan's host side, when an invitee declines.",
    category: "appointments",
    inApp: {
      subject: "Invite declined",
      body: "{{payload.collaboratorName}} declined your invitation to {{payload.planTitle}} as {{payload.role | downcase | replace: '_', ' '}}.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.COLLABORATOR_WITHDRAWN,
    name: "Collaborator left",
    description: "The plan's host side, when a collaborator leaves the team.",
    category: "appointments",
    inApp: {
      subject: "Collaborator left",
      body: "{{payload.collaboratorName}} is no longer on the team of {{payload.planTitle}} ({{payload.planType | downcase}}).",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.COLLABORATOR_INVITE_EXPIRED,
    name: "Collaborator invite expired",
    description:
      "Both the plan's host side and the invitee, when an invitation lapses.",
    category: "appointments",
    inApp: {
      subject: "Collaboration invite expired",
      body: "The collaboration invitation for {{payload.planTitle}}{% if payload.collaboratorName %} ({{payload.collaboratorName}}){% endif %} expired without a response.",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.PLAN_COHOST_JOINED,
    name: "Plan co-host joined",
    description: "Seat holders, when a named co-presenter joins their plan.",
    category: "appointments",
    inApp: {
      subject: "A new co-host",
      body: "{{payload.sentence}}",
      redirect: "dashboardUrl",
    },
  },
  {
    workflowId: W.PLAN_COHOST_LEFT,
    name: "Plan co-host left",
    description: "Seat holders, when a named co-presenter leaves their plan.",
    category: "appointments",
    inApp: {
      subject: "A co-host change",
      body: "{{payload.sentence}}",
      redirect: "dashboardUrl",
    },
  },
];
