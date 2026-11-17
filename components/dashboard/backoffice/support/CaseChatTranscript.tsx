"use client";

import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Button } from "@/components/ui/button";
import type { Tone } from "@/lib/ui/tone";
import { formatOperatorInstant } from "@/lib/time/operator-zone";
import type { TranscriptMessage } from "@/schemas/support-chat";
import { errorText, useTranscript } from "./case-chat-data";

const when = (iso: string) => formatOperatorInstant(iso);

const ROLE_KEY: Record<
  TranscriptMessage["role"],
  { label: string; tone: Tone }
> = {
  reporter: { label: "Reporter", tone: "info" },
  target: { label: "Target", tone: "warning" },
  party: { label: "Party", tone: "neutral" },
  support: { label: "Familiarise Support", tone: "success" },
  system: { label: "System", tone: "caution" },
};

/** Oldest first, whatever order the pages and their messages arrive in. */
function chronological(pages: readonly { messages: TranscriptMessage[] }[]) {
  const byId = new Map<string, TranscriptMessage>();
  for (const page of pages)
    for (const message of page.messages) byId.set(message.id, message);
  return [...byId.values()].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

function Message({ message }: Readonly<{ message: TranscriptMessage }>) {
  const role = ROLE_KEY[message.role];
  return (
    <li className="space-y-1 rounded border border-border p-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium text-foreground">
          {message.userName ?? role.label}
        </span>
        <StatusBadge label={role.label} tone={role.tone} size="sm" />
        {message.deletedBySender && (
          <StatusBadge label="Deleted by sender" tone="critical" size="sm" />
        )}
        <time dateTime={message.createdAt} className="text-muted-foreground">
          {when(message.createdAt)}
        </time>
      </div>
      {message.text && (
        <p className="whitespace-pre-wrap break-words text-sm">
          {message.text}
        </p>
      )}
      {message.attachments.length > 0 && (
        <ul aria-label="Attachments" className="text-xs text-muted-foreground">
          {message.attachments.map((attachment, index) => (
            <li key={`${attachment.name}-${index}`}>
              Attachment: {attachment.name} ({attachment.type})
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** The grant's transcript; attachments show as names and types only, never links. */
export function CaseChatTranscript({
  caseId,
  grantId,
}: Readonly<{ caseId: string; grantId: string }>) {
  const query = useTranscript(caseId, grantId);
  if (query.isPending)
    return <p className="text-xs text-muted-foreground">Loading transcript…</p>;
  if (query.isError)
    return (
      <div className="space-y-2">
        <p role="alert" className="text-xs text-destructive">
          {errorText(query.error)}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void query.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  const messages = chronological(query.data.pages);
  const windowStart = query.data.pages[0]?.windowStart;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ul aria-label="Role key" className="flex flex-wrap gap-1.5 text-xs">
          {Object.values(ROLE_KEY).map((role) => (
            <li key={role.label}>
              <StatusBadge label={role.label} tone={role.tone} size="sm" />
            </li>
          ))}
        </ul>
        <Button
          size="sm"
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? "Refreshing…" : "Refresh transcript"}
        </Button>
      </div>
      {query.hasNextPage ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "Loading…" : "Load earlier"}
        </Button>
      ) : (
        windowStart && (
          <p className="text-xs text-muted-foreground">
            Access window starts {when(windowStart)}.
          </p>
        )
      )}
      {messages.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No messages in the access window.
        </p>
      ) : (
        <ol aria-label="Chat transcript" className="space-y-2">
          {messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
        </ol>
      )}
    </div>
  );
}
