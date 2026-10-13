import type { CaseTopic } from "./case-topic";

/**
 * #1527 — saved replies for the case workspace. A static, typed registry (no
 * schema): plain, factual starting points an agent edits before sending.
 * None of them promises money or an outcome; the agent checks the case first.
 */

export interface SavedReply {
  id: string;
  title: string;
  body: string;
  thenStatus?: "RESOLVED";
}

const GENERAL: SavedReply[] = [
  {
    id: "general-ack",
    title: "Acknowledge",
    body: "Thanks for getting in touch. I'm looking into this now and will reply here as soon as I have an update.",
  },
  {
    id: "general-more-info",
    title: "Ask for details",
    body: "Could you share a little more detail, such as what you expected to happen and what you saw instead? A screenshot helps if you have one.",
  },
  {
    id: "general-waiting",
    title: "Waiting on another team",
    body: "I've passed this to the team that handles it. I'll update you here as soon as I hear back.",
  },
  {
    id: "general-resolved",
    title: "Confirm resolved",
    body: "This should now be sorted. If anything still looks wrong, reply here and the conversation will reopen.",
  },
  {
    id: "macro-resolve-closing",
    title: "Issue resolved — closing note",
    body: "This has now been sorted on our side. If anything still looks off, reply here anytime and the request will reopen automatically.",
    thenStatus: "RESOLVED",
  },
  {
    id: "general-closing",
    title: "Close after no reply",
    body: "We haven't heard back, so I'm closing this request for now. You can open a new request from Support at any time.",
  },
];

const BY_TOPIC: Partial<Record<CaseTopic, SavedReply[]>> = {
  payments: [
    {
      id: "pay-checking",
      title: "Checking the payment",
      body: "I'm checking this payment with our payment provider now and will confirm its status here.",
    },
    {
      id: "pay-pending-bank",
      title: "Pending at the bank",
      body: "The payment shows as pending on the bank's side. Banks usually settle or reverse these automatically within a few working days.",
    },
    {
      id: "pay-invoice",
      title: "Where the invoice is",
      body: "Your invoice is on your Payments page. Open the payment and use the invoice link to download it.",
    },
    {
      id: "pay-refund-timing",
      title: "Refund timing",
      body: "Refunds go only to the original payment method. After approval, allow a review window plus bank processing, typically 7–14 days end to end.",
    },
    {
      id: "macro-refund-processed-resolve",
      title: "Refund processed & resolve",
      body: "We've processed your refund back to your original payment method — typically 7–14 days end to end depending on your bank. Reply here if you need anything else.",
      thenStatus: "RESOLVED",
    },
    {
      id: "pay-reference",
      title: "Ask for a reference",
      body: "Could you share the transaction reference or UTR from your bank statement? It helps me match the payment quickly.",
    },
    {
      id: "pay-duplicate",
      title: "Possible duplicate charge",
      body: "I can see more than one attempt for this booking. I'm checking which one was captured and will update you here.",
    },
  ],
  cancellation: [
    {
      id: "cancel-how",
      title: "How to cancel",
      body: "You can cancel from the booking's page: open the appointment and choose Cancel booking. The refund shown there follows the cancellation policy.",
    },
    {
      id: "cancel-policy",
      title: "Policy explained",
      body: "The refund for a cancellation depends on how far ahead of the session it is made. The booking page shows the exact amount before you confirm.",
    },
    {
      id: "cancel-checking",
      title: "Reviewing the cancellation",
      body: "I'm reviewing this cancellation and the refund that applies, and will reply here with what happens next.",
    },
    {
      id: "cancel-done",
      title: "Cancellation recorded",
      body: "The cancellation is recorded. Any refund due goes back to the original payment method.",
    },
    {
      id: "cancel-expert",
      title: "Expert cancelled",
      body: "The expert cancelled this session. You don't need to do anything else to receive what the policy provides.",
    },
  ],
  scheduling: [
    {
      id: "sched-how",
      title: "How to reschedule",
      body: "Open the appointment and choose Reschedule to request a new time. The expert confirms the new time before it replaces the old one.",
    },
    {
      id: "sched-timezone",
      title: "Time zone check",
      body: "Times are shown in the time zone set on your account. Please check it in Settings, since a wrong zone makes sessions look shifted.",
    },
    {
      id: "sched-waiting-expert",
      title: "Waiting on the expert",
      body: "Your reschedule request is with the expert. You'll get a notification as soon as they accept or suggest another time.",
    },
    {
      id: "sched-no-slots",
      title: "No slots shown",
      body: "If no times appear, the expert has no published availability in that range. Try a later week, or message the expert from the booking.",
    },
    {
      id: "sched-done",
      title: "Moved",
      body: "The session has been moved to the new time. Your calendar invite and reminders follow the new time.",
    },
  ],
  session: [
    {
      id: "session-reviewing",
      title: "Reviewing the session",
      body: "I'm reviewing what happened in this session, including the call records, and will reply here.",
    },
    {
      id: "session-no-show-check",
      title: "No-show check",
      body: "I'm checking the call attendance for this session to confirm who joined and when.",
    },
    {
      id: "session-expert-contacted",
      title: "Contacting the expert",
      body: "I've reached out to the expert about this and will share their response here.",
    },
    {
      id: "session-feedback",
      title: "Thanks for the feedback",
      body: "Thank you for telling us. Feedback like this goes to the expert's quality review, and I'll follow up here on your specific session.",
    },
    {
      id: "session-outcome",
      title: "Outcome",
      body: "Having reviewed the session, here's what we're doing: ",
    },
  ],
  technical: [
    {
      id: "tech-browser",
      title: "Browser check",
      body: "Please try the latest version of Chrome, Edge or Safari, and allow camera and microphone access when the browser asks.",
    },
    {
      id: "tech-rejoin",
      title: "Rejoin the call",
      body: "If a call drops, you can rejoin from the same appointment while the session is still running.",
    },
    {
      id: "tech-details",
      title: "Ask for device details",
      body: "Could you tell me which device and browser you're using, and roughly what time the problem happened?",
    },
    {
      id: "tech-cache",
      title: "Refresh and retry",
      body: "Please sign out, close the tab, and sign back in. That clears most stale-session problems.",
    },
    {
      id: "tech-escalated",
      title: "Passed to engineering",
      body: "I've passed this to our engineering team with the details you shared. I'll update you here.",
    },
  ],
  recordings: [
    {
      id: "rec-where",
      title: "Where recordings are",
      body: "Recordings appear under the appointment and on your Recordings page once they are published. A processing state right after the session is normal.",
    },
    {
      id: "rec-processing",
      title: "Still processing",
      body: "This recording is still being processed. It will appear in your Recordings once it's ready.",
    },
    {
      id: "rec-not-recorded",
      title: "Not recorded",
      body: "This session wasn't recorded, so there is no recording to share.",
    },
    {
      id: "rec-checking",
      title: "Checking storage",
      body: "I'm checking the recording's status and storage for this session and will update you here.",
    },
    {
      id: "rec-expiry",
      title: "Availability window",
      body: "Recordings stay available for a limited period after the session. The Help Center article on recording expiry has the details.",
    },
  ],
};

/** The topic's replies first, then the general ones. */
export function savedRepliesFor(topic: CaseTopic): SavedReply[] {
  return [...(BY_TOPIC[topic] ?? []), ...GENERAL];
}
