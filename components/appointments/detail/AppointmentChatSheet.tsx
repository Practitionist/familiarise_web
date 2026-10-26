"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, MessageSquareOff, X } from "lucide-react";
import { useChatContext } from "stream-chat-react";
import { z } from "zod";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ChatSurface } from "@/components/chat/ChatSurface";
import { ChatContainer } from "@/components/chat/ChatContainer";
import { ChatPaneProvider } from "@/components/chat/ChatPaneContext";
import { bookingTagQueryOptions } from "@/components/chat/BookingTag";
import { useOrgScope } from "@/hooks/useOrgScope";
import { scopeOrgId } from "@/lib/api/scope/parse";
import type { AppointmentChatTarget } from "@/lib/appointments/adapter";

const openResponseSchema = z.object({
  channelType: z.enum(["messaging", "team"]),
  channelId: z.string().min(1),
});
const errorBodySchema = z.object({ error: z.string() });
const OPEN_FAILED = "Could not open this conversation. Please try again.";

// No list behind the conversation: the sheet's own close button is the only way out.
const SHEET_PANE = { conversationOpen: true, openConversation: () => {} };

function SheetChatLoading() {
  return (
    <div className="space-y-3 p-4" aria-busy="true">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-16 w-3/4" />
      <Skeleton className="ml-auto h-16 w-2/3" />
    </div>
  );
}

type OpenedChannel = z.infer<typeof openResponseSchema>;

class OpenRefused extends Error {}

/** Server-resolved channels per user and request for this page session, so a reopen skips the route. */
const openedChannels = new Map<string, OpenedChannel>();

async function openChannel(key: string, body: string): Promise<OpenedChannel> {
  const cached = openedChannels.get(key);
  if (cached) return cached;
  const res = await fetch("/api/stream/channels/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const refusal = errorBodySchema.safeParse(json);
    throw new OpenRefused(refusal.success ? refusal.data.error : OPEN_FAILED);
  }
  const opened = openResponseSchema.parse(json);
  openedChannels.set(key, opened);
  return opened;
}

/** Opens the target through the same server route as the Messages deep link, then mounts that one channel. */
function AppointmentChatPane({
  target,
}: Readonly<{ target: AppointmentChatTarget }>) {
  const { client, channel, setActiveChannel } = useChatContext();
  const queryClient = useQueryClient();
  const tagAppointmentId = target.kind === "dm" ? target.appointmentId : null;
  const { scope } = useOrgScope({ defaultForOrgMember: "personal" });
  const organizationId = scopeOrgId(scope) ?? null;
  const body = JSON.stringify(
    target.kind === "dm"
      ? {
          kind: "dm",
          counterpartyUserId: target.counterpartyUserId,
          organizationId,
        }
      : { kind: "event", eventType: target.eventType, eventId: target.eventId },
  );
  const [result, setResult] = useState<{
    body: string;
    cid?: string;
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (!client?.userID) return;
    let cancelled = false;
    const key = `${client.userID}:${body}`;
    const open = async () => {
      try {
        const { channelType, channelId } = await openChannel(key, body);
        // The tag lookup runs alongside `watch`, so the chip is ready with the composer.
        if (tagAppointmentId) {
          void queryClient.prefetchQuery(
            bookingTagQueryOptions(
              tagAppointmentId,
              `${channelType}:${channelId}`,
            ),
          );
        }
        const opened = client.channel(channelType, channelId);
        if (!opened.initialized) await opened.watch();
        if (cancelled) return;
        await setActiveChannel(opened);
        setResult({ body, cid: opened.cid });
      } catch (error) {
        openedChannels.delete(key);
        if (!cancelled) {
          setResult({
            body,
            error: error instanceof OpenRefused ? error.message : OPEN_FAILED,
          });
        }
      }
    };
    void open();
    return () => {
      cancelled = true;
    };
  }, [body, client, queryClient, setActiveChannel, tagAppointmentId]);

  const current = result?.body === body ? result : null;
  if (current?.error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={MessageSquareOff}
          title="Chat unavailable"
          description={current.error}
        />
      </div>
    );
  }
  if (!current?.cid || channel?.cid !== current.cid)
    return <SheetChatLoading />;

  return (
    <ChatPaneProvider value={SHEET_PANE}>
      <ChatContainer contextAppointmentId={tagAppointmentId} />
    </ChatPaneProvider>
  );
}

/**
 * The appointment's chat in a right-side sheet (full screen on mobile), so the
 * page stays in place. It shares the app's one Stream client and connection states.
 */
export function AppointmentChatSheet({
  target,
  onClose,
}: Readonly<{ target: AppointmentChatTarget; onClose: () => void }>) {
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        hideClose
        className="flex h-dvh max-h-dvh w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
      >
        <SheetHeader className="shrink-0 flex-row items-start justify-between gap-2 space-y-0 border-b border-border py-2 pl-4 pr-2 text-left">
          <div className="min-w-0 space-y-1 py-1">
            <SheetTitle className="text-base">{target.title}</SheetTitle>
            <SheetDescription asChild>
              <Link
                href={target.messagesHref}
                className="inline-flex w-fit items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline"
              >
                Open in Messages
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </Link>
            </SheetDescription>
          </div>
          <SheetClose className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:w-8">
            <X className="h-5 w-5 sm:h-4 sm:w-4" aria-hidden="true" />
            <span className="sr-only">Close</span>
          </SheetClose>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ChatSurface loading={<SheetChatLoading />}>
            <AppointmentChatPane target={target} />
          </ChatSurface>
        </div>
      </SheetContent>
    </Sheet>
  );
}
