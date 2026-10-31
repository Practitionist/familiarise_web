"use client";

import Image from "next/image";
import { format } from "date-fns";
import { UserIcon } from "lucide-react";
import type { AppointmentSearchResult } from "@/schemas/stream-search";

/**
 * One row per conversation: a consultation and a subscription with the same
 * person collapse into a single entry, because they are a single channel.
 * A pair has one DM thread per funding context, so the badges
 * "Consultation & Subscription" describe two reasons to be in one thread, not
 * two threads.
 */
export type GroupedConversation = {
  counterpartyName: string;
  counterpartyImage?: string;
  counterpartyUserId?: string;
  organizationId?: string | null;
  hasConsultation: boolean;
  hasSubscription: boolean;
  channelId: string;
  /**
   * The plan titles behind this row, deduplicated.
   *
   * Rendered because the route matches on plan title as well as on names, so a
   * row could match a query the UI never showed: searching "michael" surfacing
   * a conversation with Robert Brown is correct if Robert booked a plan called
   * "Michael's…", but with only the counterparty's name on screen it reads as a
   * broken search. One row can hold more than one title.
   */
  planTitles: string[];
  /** The soonest session among this conversation's matched rows (ISO). */
  startsAt?: string;
  /** Shown only when the search matched the email rather than the name. */
  counterpartyEmail?: string;
};

export const formatSessionTime = (iso: string) =>
  format(new Date(iso), "EEE d MMM, h:mm a");

/** Fold one result into its conversation, keyed on the channel (the identity of a thread). */
export function mergeConversationRow(
  byChannel: Map<string, GroupedConversation>,
  result: AppointmentSearchResult,
) {
  const existing = byChannel.get(result.channelId);
  if (existing) {
    existing.hasConsultation ||= result.type === "consultation";
    existing.hasSubscription ||= result.type === "subscription";
    if (!existing.planTitles.includes(result.name)) {
      existing.planTitles.push(result.name);
    }
    // ISO timestamps from `toISOString` compare correctly as strings.
    if (
      result.startsAt &&
      (!existing.startsAt || result.startsAt < existing.startsAt)
    ) {
      existing.startsAt = result.startsAt;
    }
    existing.counterpartyEmail ??= result.counterpartyEmail;
    return;
  }
  byChannel.set(result.channelId, {
    counterpartyName: result.counterpartyName,
    counterpartyImage: result.counterpartyImage,
    counterpartyUserId: result.counterpartyUserId,
    organizationId: result.organizationId,
    hasConsultation: result.type === "consultation",
    hasSubscription: result.type === "subscription",
    channelId: result.channelId,
    planTitles: [result.name],
    startsAt: result.startsAt,
    counterpartyEmail: result.counterpartyEmail,
  });
}

/** The one-to-one conversations in `results`, grouped by channel, in the order given. */
export function groupConversations(
  results: AppointmentSearchResult[],
): GroupedConversation[] {
  const byChannel = new Map<string, GroupedConversation>();
  for (const result of results) {
    if (result.type === "consultation" || result.type === "subscription") {
      mergeConversationRow(byChannel, result);
    }
  }
  return Array.from(byChannel.values());
}

/** A person you can open a conversation with: who, why they matched, and when you next meet. */
export const ConversationResultRow = ({
  conversation,
  onClick,
}: {
  conversation: GroupedConversation;
  onClick: () => void;
}) => (
  <button
    type="button"
    className="p-3 hover:bg-muted cursor-pointer w-full text-left border-b border-border last:border-b-0"
    onClick={onClick}
  >
    <div className="flex items-center gap-3">
      {conversation.counterpartyImage ? (
        <Image
          src={conversation.counterpartyImage}
          alt={conversation.counterpartyName}
          width={40}
          height={40}
          className="w-10 h-10 rounded-full flex-shrink-0"
        />
      ) : (
        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
          <span className="text-muted-foreground font-medium">
            {conversation.counterpartyName.charAt(0)}
          </span>
        </div>
      )}

      <div className="flex-1 min-w-0">
        <div className="font-semibold text-foreground truncate">
          {conversation.counterpartyName}
        </div>

        <div className="flex items-center gap-1 mt-1">
          <UserIcon className="w-3 h-3 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">
            {conversation.hasConsultation && conversation.hasSubscription
              ? "Consultation & Subscription"
              : conversation.hasConsultation
                ? "Consultation"
                : "Subscription"}
          </span>
        </div>

        {conversation.planTitles.length > 0 && (
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {conversation.planTitles.join(" · ")}
          </div>
        )}
        {conversation.counterpartyEmail && (
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {conversation.counterpartyEmail}
          </div>
        )}
        {conversation.startsAt && (
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            {formatSessionTime(conversation.startsAt)}
          </div>
        )}
      </div>
    </div>
  </button>
);
