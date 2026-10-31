"use client";

import { useEffect, useMemo, useState } from "react";
import { useDebounce } from "use-debounce";
import { PlusIcon } from "lucide-react";
import type { Channel } from "stream-chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
  ResponsiveModalTrigger,
} from "@/components/ui/responsive-modal";
import { Skeleton } from "@/components/ui/skeleton";
import { scopeOrgId, type Scope } from "@/lib/api/scope/parse";
import type { AppointmentSearchResult } from "@/schemas/stream-search";
import {
  ConversationResultRow,
  groupConversations,
  type GroupedConversation,
} from "./ConversationResult";
import { useOpenConversation } from "./useOpenConversation";

/**
 * "New message": the people you can message, for when you have forgotten the name
 * or the conversation is not in your list.
 *
 * It lists the same people the search can find (everyone you share a consultation
 * or subscription with) and opens one through `/api/stream/channels/open`, so the
 * server's booking check is the only gate. With no text it shows your most recent
 * connections; typing searches all of them.
 */
export const NewMessageDialog = ({
  scope,
  onOpened,
}: {
  scope: Scope;
  onOpened: (channel: Channel) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [debouncedTerm] = useDebounce(term.trim(), 300);
  // null while the first answer for the current term is on its way.
  const [results, setResults] = useState<AppointmentSearchResult[] | null>(
    null,
  );
  const [loadError, setLoadError] = useState(false);
  const {
    open: openConversation,
    openError,
    setOpenError,
  } = useOpenConversation({ onOpened });

  const pinnedOrgId = scopeOrgId(scope);
  const scopeParam = pinnedOrgId ? `org:${pinnedOrgId}` : "personal";

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoadError(false);
    setResults(null);

    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const params = new URLSearchParams({
      mode: "people",
      q: debouncedTerm,
      scope: scopeParam,
      tz: zone,
    });
    fetch(`/api/stream/channels/search-appointments?${params}`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Failed to load people");
        return response.json() as Promise<AppointmentSearchResult[]>;
      })
      .then((rows) => {
        if (!controller.signal.aborted) setResults(rows);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        console.error("Error loading people:", error);
        setLoadError(true);
      });

    // A newer term or a closed dialog abandons this request.
    return () => controller.abort();
  }, [open, debouncedTerm, scopeParam]);

  const people = useMemo(
    () => (results ? groupConversations(results) : []),
    [results],
  );
  // The input is ahead of the debounced request, so say "loading" rather than
  // announcing an empty list for a term that has not been searched yet.
  const isPending = results === null || term.trim() !== debouncedTerm;

  const handlePick = async (person: GroupedConversation) => {
    // A row with no user id cannot be opened, and the route would answer 400.
    if (!person.counterpartyUserId) {
      setOpenError("This conversation is missing its participant.");
      return;
    }
    const opened = await openConversation({
      kind: "dm",
      counterpartyUserId: person.counterpartyUserId,
      organizationId: person.organizationId ?? null,
    });
    if (opened) setOpen(false);
  };

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setTerm("");
          setOpenError(null);
        }
      }}
    >
      <ResponsiveModalTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label="New message"
          title="New message"
          className="p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <PlusIcon className="h-4 w-4" />
        </Button>
      </ResponsiveModalTrigger>
      <ResponsiveModalContent className="sm:max-w-[425px]">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>New message</ResponsiveModalTitle>
          <ResponsiveModalDescription>
            People you have booked a session with.
          </ResponsiveModalDescription>
        </ResponsiveModalHeader>

        <Input
          autoFocus
          type="text"
          placeholder="Search by name"
          aria-label="Search people"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          className="text-sm normal-case"
        />

        {openError && (
          <p role="status" className="text-sm text-muted-foreground">
            {openError}
          </p>
        )}

        <div className="max-h-[50vh] overflow-auto rounded-md border border-border">
          {loadError ? (
            <p className="p-4 text-center text-sm text-destructive">
              People could not be loaded. Please try again.
            </p>
          ) : isPending ? (
            <div className="space-y-3 p-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-1/2" />
                    <Skeleton className="h-2.5 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : people.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">
              {debouncedTerm
                ? `No one matches “${debouncedTerm}”.`
                : "No one to message yet. A conversation opens once you book a session."}
            </p>
          ) : (
            people.map((person) => (
              <ConversationResultRow
                key={person.channelId}
                conversation={person}
                onClick={() => void handlePick(person)}
              />
            ))
          )}
        </div>
      </ResponsiveModalContent>
    </ResponsiveModal>
  );
};
