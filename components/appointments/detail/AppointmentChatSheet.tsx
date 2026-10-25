"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ExternalLink, MessageSquareOff } from "lucide-react";
import { useChatContext } from "stream-chat-react";
import { z } from "zod";
import {
  Sheet,
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
import { useOrgScope } from "@/hooks/useOrgScope";
import { scopeOrgId } from "@/lib/api/scope/parse";
import type { AppointmentChatTarget } from "@/lib/appointments/adapter";

const openResponseSchema = z.object({
  channelType: z.enum(["messaging", "team"]),
  channelId: z.string().min(1),
});
const errorBodySchema = z.object({ error: z.string() });
const OPEN_FAILED = "Could not open this conversation. Please try again.";

const noop = () => {};

function SheetChatLoading() {
  return (
    <div className="space-y-3 p-4" aria-busy="true">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-16 w-3/4" />
      <Skeleton className="ml-auto h-16 w-2/3" />
    </div>
  );
}

/** Opens the target through the same server route as the Messages deep link, then mounts that one channel. */
function AppointmentChatPane({
  target,
  onBack,
}: Readonly<{ target: AppointmentChatTarget; onBack: () => void }>) {
  const { client, channel, setActiveChannel } = useChatContext();
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
    const open = async () => {
      try {
        const res = await fetch("/api/stream/channels/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        const json: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          const refusal = errorBodySchema.safeParse(json);
          if (!cancelled) {
            setResult({
              body,
              error: refusal.success ? refusal.data.error : OPEN_FAILED,
            });
          }
          return;
        }
        const { channelType, channelId } = openResponseSchema.parse(json);
        const opened = client.channel(channelType, channelId);
        await opened.watch();
        if (cancelled) return;
        await setActiveChannel(opened);
        setResult({ body, cid: opened.cid });
      } catch {
        if (!cancelled) setResult({ body, error: OPEN_FAILED });
      }
    };
    void open();
    return () => {
      cancelled = true;
    };
  }, [body, client, setActiveChannel]);

  const pane = useMemo(
    () => ({
      conversationOpen: true,
      openConversation: noop,
      backToList: onBack,
    }),
    [onBack],
  );

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
    <ChatPaneProvider value={pane}>
      <ChatContainer
        contextAppointmentId={
          target.kind === "dm" ? target.appointmentId : null
        }
      />
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
}: Readonly<{ target: AppointmentChatTarget | null; onClose: () => void }>) {
  return (
    <Sheet
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-lg"
      >
        <SheetHeader className="border-b border-border px-4 py-3 pr-12 text-left">
          <SheetTitle className="text-base">
            {target?.title ?? "Chat"}
          </SheetTitle>
          <SheetDescription asChild>
            {target ? (
              <Link
                href={target.messagesHref}
                className="inline-flex w-fit items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline"
              >
                Open in Messages
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </Link>
            ) : (
              <span />
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1">
          {target && (
            <ChatSurface loading={<SheetChatLoading />}>
              <AppointmentChatPane target={target} onBack={onClose} />
            </ChatSurface>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
