/**
 * The chat unread digest email. Every line is built from counterpart names,
 * counts and session dates; message text never reaches this module.
 */
import * as React from "react";
import UnreadMessagesDigestEmail, {
  unreadMessagesDigestSubject,
} from "@/emails/chat/UnreadMessagesDigestEmail";
import {
  dateText,
  greet,
  prepareSpecEmails,
  type PreparedRecipientEmails,
} from "./shared";

export const CHAT_UNREAD_DIGEST_EMAIL_TYPE = "CHAT_UNREAD_DIGEST";

export interface ChatDigestThread {
  counterpartNames: string[];
  /** New messages from others since the recipient's last own message. */
  newMessages: number;
  /** True when all of Stream's last five messages are new, so the real count may be higher. */
  capped: boolean;
  sessionStartsAt: Date | null;
  href: string;
}

function namesText(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "your contact";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function chatDigestLine(thread: ChatDigestThread, zone: string): string {
  const count = thread.capped
    ? `${thread.newMessages}+`
    : `${thread.newMessages}`;
  const noun =
    thread.newMessages === 1 && !thread.capped ? "message" : "messages";
  const session = thread.sessionStartsAt
    ? ` about your session on ${dateText(thread.sessionStartsAt, zone)}`
    : "";
  return `You have ${count} new ${noun} from ${namesText(thread.counterpartNames)}${session}.`;
}

/** Rendered outside any transaction; the caller stages the result. */
export function prepareChatUnreadDigestEmail(args: {
  userId: string;
  entityRef: string;
  threads: ChatDigestThread[];
}): Promise<PreparedRecipientEmails> {
  return prepareSpecEmails(
    {
      emailType: CHAT_UNREAD_DIGEST_EMAIL_TYPE,
      category: "appointments",
      entityRef: args.entityRef,
      subject: () => unreadMessagesDigestSubject(args.threads.length),
      render: (r) =>
        React.createElement(UnreadMessagesDigestEmail, {
          recipientName: greet(r),
          threads: args.threads.map((thread) => ({
            line: chatDigestLine(thread, r.zone),
            href: thread.href,
          })),
          unsubscribeUrl: r.unsubscribeUrl,
        }),
    },
    [args.userId],
  );
}
