"use client";

import { RefreshCwIcon } from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
  startTransition,
} from "react";
import type { Channel, ChannelSort, Event } from "stream-chat";
import { useChatContext } from "stream-chat-react";
import { getChannelTypeFromId, isEventChannel } from "@/lib/stream-channel-ids";
import { ChannelItem } from "./ChannelItem";
import { ChannelSearch } from "./ChannelSearch";
import { NewMessageDialog } from "./NewMessageDialog";
import { CreateChannelDialog } from "./CreateChannelDialog";
import { InitializeUserChannelsButton } from "./InitializeUserChannelsButton";
import { DebugDialog } from "./DebugDialog";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import {
  buildOrgChannelFilter,
  filterChannelsByTerm,
  isUsableDmChannel,
  MIN_SEARCH_LENGTH,
  pinnedFirst,
  channelPinnedAt,
} from "./utils/channelUtils";
import { appendUniqueChannels, insertChannelAtTop } from "./utils/channelList";
import { useChatPane } from "./ChatPaneContext";
import { useOrgScope } from "@/hooks/useOrgScope";
import { scopeOrgId } from "@/lib/api/scope/parse";
import { useSession } from "@/lib/auth-client";
import { useServerSessionFacts } from "@/components/dashboard/ServerUserId";
import { useSearchParams } from "next/navigation";
import { useToast } from "@/components/ui/use-toast";

// One loading language across chat: the same Skeleton primitive the rest of
// the dashboard uses, shaped like the rows it stands in for.
const ChannelListSkeleton = () => (
  <div className="space-y-2 p-4">
    {[1, 2, 3].map((i) => (
      <div key={i} className="flex items-center gap-3">
        <Skeleton className="h-6 w-6 shrink-0 rounded-full" />
        <div className="flex-1 space-y-1">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-2.5 w-1/2" />
        </div>
      </div>
    ))}
  </div>
);

type ListType = "team" | "messaging";

const PAGE_SIZE = 20;
// Pinned first, then latest activity; offset paging relies on every page using it.
const CHANNEL_SORT: ChannelSort = [{ pinned_at: -1 }, { last_message_at: -1 }];

const listTypeOf = (channel: Channel): ListType =>
  channel.type === "team" ? "team" : "messaging";

/** Pin, unpin or hide one conversation for the signed-in user; throws when it did not take. */
async function updateConversationPreference(
  channel: Channel,
  action: "pin" | "unpin" | "hide",
): Promise<void> {
  const response = await fetch("/api/stream/channels/preference", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channelType: channel.type,
      channelId: channel.id,
      action,
    }),
  });
  if (!response.ok) throw new Error("Preference update failed");
}

/** What an empty Conversations list says, by who is looking and where. */
function noConversationsMessage(
  inOrganization: boolean,
  isConsultant: boolean,
) {
  if (inOrganization) {
    return "No conversations yet. Threads appear here once you're part of a session in this organization.";
  }
  if (isConsultant) {
    return "No conversations yet. Conversations will appear here once clients book sessions.";
  }
  return "No conversations yet. Book a consultation to start chatting.";
}

type OrgScope = ReturnType<typeof useOrgScope>["scope"];

function doesChannelMatchScope(ch: unknown, currentScope: OrgScope): boolean {
  if (!ch || typeof ch !== "object") return false;
  const record = ch as {
    organization_id?: unknown;
    data?: Record<string, unknown>;
  };
  const rawOrgId = record.data?.organization_id ?? record.organization_id;
  if (currentScope.kind === "personal") {
    return rawOrgId === undefined || rawOrgId === null;
  }
  const pinnedOrgId = scopeOrgId(currentScope);
  return pinnedOrgId ? rawOrgId === pinnedOrgId : true;
}

/** The fetched rows, with any `keepCids` row the fetch left out kept on top. */
function mergeFetchedChannels(
  prev: Channel[],
  fetched: Channel[],
  currentScope: OrgScope,
  keepCids: ReadonlyArray<string | null>,
): Channel[] {
  const fetchedCids = new Set(fetched.map((ch) => ch.cid));
  const preserved = prev.filter(
    (ch) =>
      keepCids.includes(ch.cid) &&
      !fetchedCids.has(ch.cid) &&
      doesChannelMatchScope(ch, currentScope),
  );
  return preserved.length > 0 ? [...preserved, ...fetched] : fetched;
}

function pickInitialChannel(
  mostRecentTeam: Channel | undefined,
  mostRecentDM: Channel | undefined,
): Channel | null {
  if (mostRecentTeam && mostRecentDM) {
    const teamTime = new Date(
      (mostRecentTeam.data?.last_message_at as string) || 0,
    ).getTime();
    const dmTime = new Date(
      (mostRecentDM.data?.last_message_at as string) || 0,
    ).getTime();
    return dmTime >= teamTime ? mostRecentDM : mostRecentTeam;
  }
  return mostRecentTeam || mostRecentDM || null;
}

function parseDeepLinkChannelTarget(rawChannelId: string): {
  channelType: "messaging" | "team";
  channelId: string;
} {
  const colonIdx = rawChannelId.indexOf(":");
  if (colonIdx > 0) {
    const prefix = rawChannelId.slice(0, colonIdx);
    const channelType = prefix === "messaging" ? "messaging" : "team";
    return { channelType, channelId: rawChannelId.slice(colonIdx + 1) };
  }
  return {
    channelType: getChannelTypeFromId(rawChannelId),
    channelId: rawChannelId,
  };
}

function getChannelLastMessageTime(
  channel: Channel,
  targetCid: string,
  eventMessageCreatedAt?: string | Date,
): number {
  if (channel.cid === targetCid && eventMessageCreatedAt) {
    return new Date(eventMessageCreatedAt).getTime();
  }
  const rawLast =
    (channel.state?.last_message_at as string | Date | undefined) ||
    (channel.data?.last_message_at as string | undefined) ||
    0;
  return new Date(rawLast).getTime();
}

function sortUpdatedChannels(
  channels: Channel[],
  targetCid: string,
  isNewMessage: boolean,
  eventMessageCreatedAt?: string | Date,
): Channel[] {
  if (!isNewMessage) return channels;
  return [...channels].sort(
    (a, b) =>
      getChannelLastMessageTime(b, targetCid, eventMessageCreatedAt) -
      getChannelLastMessageTime(a, targetCid, eventMessageCreatedAt),
  );
}

export const ChatSidebar = () => {
  const { client, setActiveChannel } = useChatContext();
  const { openConversation, markLinkUnavailable } = useChatPane();
  const { toast } = useToast();
  // The app role, NOT `client.user.role` — mapRoleToStream collapses every
  // non-staff account to Stream's `"user"`, so the old `=== "consultant"`
  // check here could never be true.
  const { data: session } = useSession();
  const serverFacts = useServerSessionFacts();
  const appRole = session?.user?.role ?? serverFacts.role;
  const isConsultant =
    appRole === "CONSULTANT" ||
    Boolean(
      (session?.user as { consultantProfileId?: string | null } | undefined)
        ?.consultantProfileId,
    );
  // Channels can only be created against a webinar or class the viewer hosts,
  // so a consultee's dropdown had exactly one entry: "No events found".
  const canCreateChannels =
    isConsultant || appRole === "ADMIN" || appRole === "STAFF";
  // Route-pinned under /dashboard/organization/[orgId]/ — that mount scopes
  // itself to the org and this option is ignored there. Everywhere else this
  // component renders is a PERSONAL dashboard, and ADR 19 pins personal to
  // `organizationId: null`, so B2C is the right default rather than the hook's
  // `first-org` (which silently hid a member's B2C threads behind whichever org
  // happened to be first, and hid a second org's entirely).
  const { scope } = useOrgScope({ defaultForOrgMember: "personal" });
  const scopeRef = useRef(scope);
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);
  const searchParams = useSearchParams();
  const counterpartyUserId =
    searchParams?.get("counterpartyUserId") ??
    searchParams?.get("peerUserId") ??
    null;
  const deepLinkEventType = searchParams?.get("eventType") ?? null;
  const deepLinkEventId = searchParams?.get("eventId") ?? null;
  const deepLinkChannelId = searchParams?.get("channelId") ?? null;
  const hasDeepLink = Boolean(
    counterpartyUserId ||
    (deepLinkEventType && deepLinkEventId) ||
    deepLinkChannelId,
  );
  const deepLinkHandledRef = useRef<string | null>(null);
  const deepLinkedChannelCidRef = useRef<string | null>(null);
  const [teamChannels, setTeamChannels] = useState<Channel[]>([]);
  const [directMessages, setDirectMessages] = useState<Channel[]>([]);
  // What the search box holds; both lists below narrow to it instantly.
  const [searchTerm, setSearchTerm] = useState("");
  const isFiltering = searchTerm.trim().length >= MIN_SEARCH_LENGTH;
  // Pins changed since the lists loaded, shown at once while the rebase that
  // follows a successful change re-reads the loaded rows in the server's order.
  const [pinOverrides, setPinOverrides] = useState<
    Record<string, string | null>
  >({});
  const visibleTeamChannels = useMemo(
    () =>
      pinnedFirst(
        filterChannelsByTerm(teamChannels, client?.userID, searchTerm),
        pinOverrides,
      ),
    [teamChannels, client?.userID, searchTerm, pinOverrides],
  );
  const visibleDirectMessages = useMemo(
    () =>
      pinnedFirst(
        filterChannelsByTerm(directMessages, client?.userID, searchTerm),
        pinOverrides,
      ),
    [directMessages, client?.userID, searchTerm, pinOverrides],
  );
  // Handed to the search dropdown so it leaves out rows this list already shows.
  const listedChannelIds = useMemo(
    () =>
      new Set(
        isFiltering
          ? [...visibleTeamChannels, ...visibleDirectMessages].flatMap((ch) =>
              ch.id ? [ch.id] : [],
            )
          : [],
      ),
    [isFiltering, visibleTeamChannels, visibleDirectMessages],
  );
  // The listener below reads the lists through refs so it can tell a message
  // for a channel outside the loaded page without re-attaching per update.
  const listedCidsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    listedCidsRef.current = new Set(
      [...teamChannels, ...directMessages].map((ch) => ch.cid),
    );
  }, [teamChannels, directMessages]);
  const pendingCidsRef = useRef<Set<string>>(new Set());
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  // #248: mirror activeChannelId into a ref so handleChannelDeleted can read the
  // current selection WITHOUT depending on the state. Without this, every
  // channel selection changed handleChannelDeleted's identity, which re-ran the
  // event-listener effect and detached/re-attached the Stream listener on each
  // click. The listener effect now depends only on `client`.
  const activeChannelIdRef = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const initialSelectionDoneRef = useRef(false);
  // #248 dedupe: guard against overlapping/duplicate channel fetches. The
  // sidebar effect used to re-run (and refetch) on every channel selection and
  // on useCallback identity churn, firing the queryChannels storm. We track the
  // *key* (client+scope) currently in flight, not just a boolean: skipping only
  // the SAME key means an org-scope switch DURING an in-flight fetch is not
  // silently dropped (the prior bug left the new scope marked "fetched" while
  // showing the old scope's data).
  const inFlightFetchKeyRef = useRef<string | null>(null);
  // Tracks the client+scope we've SUCCESSFULLY fetched for, so the initial-fetch
  // effect is a no-op on unrelated re-renders. Recorded only after a request
  // succeeds (not when a fetch is skipped) so a skipped/failed fetch never
  // marks a scope as done. Refetch still happens on a genuine client/scope change.
  const fetchedKeyRef = useRef<string | null>(null);
  /**
   * How many rows Stream has actually returned per list, before filtering.
   *
   * The pagination offset must count what the SERVER has handed over, not what
   * survived `isUsableDmChannel`. Using `directMessages.length` meant every
   * phantom dropped from a page shifted the next offset backwards by one, so
   * page two re-fetched rows already on screen and the tail of the list became
   * unreachable — the filter silently ate the pagination.
   */
  const fetchedCountRef = useRef<Record<ListType, number>>({
    team: 0,
    messaging: 0,
  });
  // Bumped whenever a list is replaced; a page requested under an older value is dropped.
  const listGenerationRef = useRef<Record<ListType, number>>({
    team: 0,
    messaging: 0,
  });
  // The generation each list was last replaced at; behind the live one while a newer read is in flight.
  const appliedGenerationRef = useRef<Record<ListType, number>>({
    team: 0,
    messaging: 0,
  });
  // Set once a preference change has moved rows across the offset and cleared when a
  // re-read lands; while set, Load more re-reads the list instead of paging from it.
  const staleListRef = useRef<Record<ListType, boolean>>({
    team: false,
    messaging: false,
  });
  // Pin requests in flight per cid; their override outlives any re-read until they settle.
  const pendingPinsRef = useRef<Map<string, number>>(new Map());

  // Pagination state
  const [hasMoreTeamChannels, setHasMoreTeamChannels] = useState(true);
  const [hasMoreDMChannels, setHasMoreDMChannels] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Stable key for the current (client + org-scope) pair. Both the in-flight
  // guard and the "already fetched" record key off this so a scope switch is a
  // genuinely different key (and thus never skipped against an unrelated fetch).
  const computeFetchKey = useCallback((): string | null => {
    if (!client?.userID) return null;
    // scopeOrgId, not `kind === "org"`: `orgMember` pins an org too, so keying
    // on the kind alone gave two different orgs the SAME cache key (#674).
    const pinnedOrgId = scopeOrgId(scope);
    const scopeKey = pinnedOrgId ? `org:${pinnedOrgId}` : scope.kind;
    return `${client.userID}::${scopeKey}`;
  }, [client, scope]);

  // Rows a re-read returned carry the server's pin, so drop their settled overrides.
  const settlePinOverrides = useCallback((fetched: Channel[]) => {
    const settled = new Set(
      fetched
        .map((ch) => ch.cid)
        .filter((cid) => !pendingPinsRef.current.has(cid)),
    );
    setPinOverrides((prev) => {
      const kept = Object.entries(prev).filter(([cid]) => !settled.has(cid));
      return kept.length === Object.keys(prev).length
        ? prev
        : Object.fromEntries(kept);
    });
  }, []);

  // Makes `fetched` (server order, first row onward) the list and its offset;
  // a page cut from the replaced list is dropped by the generation bump.
  const replaceList = useCallback(
    (
      type: ListType,
      fetched: Channel[],
      hasMore: boolean,
      keepCids: ReadonlyArray<string | null>,
    ) => {
      appliedGenerationRef.current[type] = ++listGenerationRef.current[type];
      fetchedCountRef.current[type] = fetched.length;
      staleListRef.current[type] = false;
      settlePinOverrides(fetched);
      const listed = appendUniqueChannels(
        [],
        type === "team" ? fetched : fetched.filter(isUsableDmChannel),
      );
      const setList = type === "team" ? setTeamChannels : setDirectMessages;
      setList((prev) => mergeFetchedChannels(prev, listed, scope, keepCids));
      if (type === "team") setHasMoreTeamChannels(hasMore);
      else setHasMoreDMChannels(hasMore);
    },
    [scope, settlePinOverrides],
  );

  // One page of a list in the server's order, scoped like the first page.
  const queryPage = useCallback(
    (userId: string, type: ListType, offset: number) =>
      client.queryChannels(
        { members: { $in: [userId] }, type, ...buildOrgChannelFilter(scope) },
        CHANNEL_SORT,
        {
          watch: true,
          state: true,
          limit: PAGE_SIZE,
          message_limit: 10,
          presence: false,
          offset,
        },
      ),
    [client, scope],
  );

  // A page cut for `pageKey` must not land once another scope has loaded or is
  // loading: it would cross-tenant the inbox and corrupt the next offset.
  const isScopeSuperseded = useCallback(
    (pageKey: string | null) =>
      fetchedKeyRef.current !== pageKey ||
      (inFlightFetchKeyRef.current !== null &&
        inFlightFetchKeyRef.current !== pageKey),
    [],
  );

  // A dropped read has already written its older membership into Stream's shared
  // Channel objects, so once the newest read has landed the list is read again.
  const isNewestReadApplied = useCallback(
    (type: ListType) =>
      appliedGenerationRef.current[type] === listGenerationRef.current[type],
    [],
  );

  // A pin, unpin or hide moves rows across the offset, so re-read the loaded rows
  // (plus `extraPages`) and reset the offset with them; a page paged meanwhile is dropped.
  const rebaseList = useCallback(
    async function rebase(type: ListType, extraPages = 0): Promise<void> {
      const userId = client?.userID;
      if (!userId) return;
      staleListRef.current[type] = true;
      const pageKey = computeFetchKey();
      const generation = ++listGenerationRef.current[type];
      const pageCount =
        Math.max(1, Math.ceil(fetchedCountRef.current[type] / PAGE_SIZE)) +
        extraPages;
      const readPages = () =>
        Promise.all(
          Array.from({ length: pageCount }, (_, i) =>
            queryPage(userId, type, i * PAGE_SIZE),
          ),
        );
      try {
        // One retry; if both reads fail the list stays stale for Load more to repair.
        const pages = await readPages().catch(readPages);
        if (isScopeSuperseded(pageKey)) return;
        if (listGenerationRef.current[type] !== generation) {
          if (isNewestReadApplied(type)) void rebase(type);
          return;
        }
        // The open and deep-linked conversations stay listed even when the
        // new order puts them past the loaded rows.
        replaceList(
          type,
          pages.flat(),
          pages[pages.length - 1].length === PAGE_SIZE,
          [deepLinkedChannelCidRef.current, activeChannelIdRef.current],
        );
      } catch (error) {
        console.error(`Error rebasing ${type} channels:`, error);
      }
    },
    [
      client,
      computeFetchKey,
      queryPage,
      isScopeSuperseded,
      isNewestReadApplied,
      replaceList,
    ],
  );

  // Function to fetch channels initially and on significant changes
  const fetchChannels = useCallback(
    async ({ silent = false } = {}) => {
      if (!client?.userID) {
        return;
      }

      const fetchKey = computeFetchKey();
      if (inFlightFetchKeyRef.current === fetchKey) {
        return;
      }
      inFlightFetchKeyRef.current = fetchKey;
      // Ordered with rebases: a list re-read after this refresh started keeps its result.
      const generation = {
        team: ++listGenerationRef.current.team,
        messaging: ++listGenerationRef.current.messaging,
      };

      // A silent refetch keeps the list on screen instead of flashing the skeleton.
      if (!silent) setIsLoading(true);
      setError(null);

      try {
        const orgFilter: Record<string, unknown> = buildOrgChannelFilter(scope);
        const filter = {
          members: { $in: [client.userID] },
          ...orgFilter,
        };
        const options = {
          watch: true,
          state: true,
          limit: PAGE_SIZE,
          message_limit: 10,
          presence: false,
        };

        const [teamResponse, dmResponse] = await Promise.all([
          client.queryChannels(
            { ...filter, type: "team" },
            CHANNEL_SORT,
            options,
          ),
          client.queryChannels(
            { ...filter, type: "messaging" },
            CHANNEL_SORT,
            options,
          ),
        ]);

        if (inFlightFetchKeyRef.current !== fetchKey) {
          return;
        }
        const keepCids = [deepLinkedChannelCidRef.current];
        for (const [type, fetched] of [
          ["team", teamResponse],
          ["messaging", dmResponse],
        ] as const) {
          if (listGenerationRef.current[type] === generation[type]) {
            replaceList(type, fetched, fetched.length === PAGE_SIZE, keepCids);
          } else if (isNewestReadApplied(type)) {
            void rebaseList(type);
          }
        }
        fetchedKeyRef.current = fetchKey;

        const usableDms = dmResponse.filter(isUsableDmChannel);

        if (!initialSelectionDoneRef.current && !hasDeepLink) {
          initialSelectionDoneRef.current = true;
          const channelToSelect = pickInitialChannel(
            teamResponse[0],
            usableDms[0],
          );
          if (channelToSelect) {
            setActiveChannel(channelToSelect);
            setActiveChannelId(channelToSelect.cid || null);
          }
        }
      } catch (err) {
        console.error("Error fetching channels:", err);
        setError("Failed to load channels. Please try refreshing.");
      } finally {
        setIsLoading(false);
        if (inFlightFetchKeyRef.current === fetchKey) {
          inFlightFetchKeyRef.current = null;
        }
      }
    },
    [
      client,
      setActiveChannel,
      scope,
      computeFetchKey,
      hasDeepLink,
      replaceList,
      isNewestReadApplied,
      rebaseList,
    ],
  );

  // Function to load more channels (pagination)
  const loadMoreChannels = useCallback(
    async (type: ListType) => {
      const userId = client?.userID;
      if (!userId || isLoadingMore) return;

      const hasMore = type === "team" ? hasMoreTeamChannels : hasMoreDMChannels;

      if (!hasMore) return;

      // The scope and list generation this page belongs to, captured before the request.
      const pageKey = computeFetchKey();
      const generation = listGenerationRef.current[type];

      setIsLoadingMore(true);

      try {
        // A stale offset would skip rows, so re-read the loaded rows plus one page.
        if (staleListRef.current[type]) {
          await rebaseList(type, 1);
          return;
        }

        // Raw fetched count, never the list length — see fetchedCountRef.
        const response = await queryPage(
          userId,
          type,
          fetchedCountRef.current[type],
        );

        if (isScopeSuperseded(pageKey)) return;
        if (listGenerationRef.current[type] !== generation) {
          if (isNewestReadApplied(type)) void rebaseList(type);
          return;
        }

        fetchedCountRef.current[type] += response.length;

        if (type === "team") {
          setTeamChannels((prev) => appendUniqueChannels(prev, response));
          setHasMoreTeamChannels(response.length === PAGE_SIZE);
        } else {
          setDirectMessages((prev) =>
            appendUniqueChannels(prev, response.filter(isUsableDmChannel)),
          );
          // Raw length again — see fetchChannels.
          setHasMoreDMChannels(response.length === PAGE_SIZE);
        }
      } catch (error) {
        console.error(`Error loading more ${type} channels:`, error);
      } finally {
        setIsLoadingMore(false);
      }
    },
    [
      client,
      // The offset comes from `fetchedCountRef`, so the lists are not read here.
      hasMoreTeamChannels,
      hasMoreDMChannels,
      isLoadingMore,
      computeFetchKey,
      queryPage,
      isScopeSuperseded,
      isNewestReadApplied,
      rebaseList,
    ],
  );

  // Handle individual channel deletion without full refresh
  const handleChannelDeleted = useCallback(
    (deletedChannelId: string) => {
      // Remove from team channels
      setTeamChannels((prevChannels) =>
        prevChannels.filter((ch) => ch.cid !== deletedChannelId),
      );

      // Remove from direct messages
      setDirectMessages((prevChannels) =>
        prevChannels.filter((ch) => ch.cid !== deletedChannelId),
      );

      // Clear active channel if it was the deleted one. Read the ref (not the
      // state) so this handler's identity stays stable across selections and the
      // event-listener effect below isn't re-run on every channel click.
      if (activeChannelIdRef.current === deletedChannelId) {
        setActiveChannel(undefined);
        setActiveChannelId(null);
      }
    },
    [setActiveChannel],
  );

  // Handle user being removed from channel
  const handleUserRemovedFromChannel = useCallback(
    (channelId: string) => {
      handleChannelDeleted(channelId); // Same logic as deletion
    },
    [handleChannelDeleted],
  );

  // Handle individual channel creation without full refresh
  const handleChannelCreated = useCallback(async () => {
    if (!client?.userID) return;

    try {
      const recentFilter = {
        members: { $in: [client.userID] },
        ...buildOrgChannelFilter(scope),
      };

      const [recentTeamChannels, recentDMChannels] = await Promise.all([
        client.queryChannels(
          { ...recentFilter, type: "team" },
          { created_at: -1 },
          { limit: 5, state: true },
        ),
        client.queryChannels(
          { ...recentFilter, type: "messaging" },
          { created_at: -1 },
          { limit: 5, state: true },
        ),
      ]);

      // Add any new channels to existing lists (avoiding duplicates)
      setTeamChannels((prevChannels) => {
        const existingIds = new Set(prevChannels.map((ch) => ch.cid));
        const newChannels = recentTeamChannels.filter(
          (ch) => !existingIds.has(ch.cid),
        );
        if (newChannels.length > 0) {
          return [...newChannels, ...prevChannels]; // New channels at top
        }
        return prevChannels;
      });

      setDirectMessages((prevChannels) => {
        const existingIds = new Set(prevChannels.map((ch) => ch.cid));
        const newChannels = recentDMChannels.filter(
          (ch) => !existingIds.has(ch.cid) && isUsableDmChannel(ch),
        );
        if (newChannels.length > 0) {
          return [...newChannels, ...prevChannels]; // New channels at top
        }
        return prevChannels;
      });
    } catch (err) {
      console.error("Error handling individual channel creation:", err);
      // Fallback to full refresh if individual handling fails
      fetchChannels();
    }
  }, [client, scope, fetchChannels]);

  // Manual refresh function
  const handleRefresh = () => {
    fetchChannels();
  };

  // #248: Initial fetch — runs once per (client + org-scope), NOT on every
  // channel selection. Previously this lived in the same effect as the event
  // listener, whose deps included `activeChannelId`; selecting a channel
  // re-ran the effect and refired the full queryChannels pair, producing the
  // home/chat call-storm. The key guard makes unrelated re-renders a no-op
  // while still refetching on a real client or scope change.
  useEffect(() => {
    if (!client?.userID) {
      setIsLoading(true);
      setTeamChannels([]);
      setDirectMessages([]);
      fetchedKeyRef.current = null;
      inFlightFetchKeyRef.current = null;
      return;
    }

    const fetchKey = computeFetchKey();
    if (fetchedKeyRef.current === fetchKey) {
      return; // already SUCCESSFULLY fetched for this client+scope
    }
    // Do NOT pre-mark fetchedKeyRef here — fetchChannels records it only after
    // its request succeeds, so a skipped (in-flight) or failed fetch can't leave
    // a scope marked done with another scope's data.
    // Reset auto-selection so a scope switch can pick a fresh default channel.
    initialSelectionDoneRef.current = false;
    fetchChannels();
  }, [client, scope, fetchChannels, computeFetchKey]);

  // #248: Event listener — attached once per client (not per channel click).
  // Kept separate from the initial fetch so selecting a channel no longer tears
  // down/re-attaches the listener or refires queryChannels.
  useEffect(() => {
    if (!client) return;
    let disposed = false;

    // Watches a channel the sidebar does not hold yet and puts it first.
    const addChannelToLists = async (
      eventChannel: NonNullable<Event["channel"]>,
    ) => {
      const channelType = eventChannel.type;
      const channelId = eventChannel.id;
      if (!doesChannelMatchScope(eventChannel, scopeRef.current)) {
        return;
      }
      const newChannel = client.channel(channelType, channelId);
      if (pendingCidsRef.current.has(newChannel.cid)) return;
      pendingCidsRef.current.add(newChannel.cid);
      try {
        await newChannel.watch();
        // The client or org scope may have changed while watch() was pending.
        if (
          disposed ||
          !doesChannelMatchScope(eventChannel, scopeRef.current)
        ) {
          return;
        }
        if (channelType === "team") {
          setTeamChannels((prev) => insertChannelAtTop(prev, newChannel));
        } else if (
          channelType === "messaging" &&
          isUsableDmChannel(newChannel)
        ) {
          setDirectMessages((prev) => insertChannelAtTop(prev, newChannel));
        }
      } catch {
        // A failed watch leaves the channel unlisted so the next event retries it.
      } finally {
        pendingCidsRef.current.delete(newChannel.cid);
      }
    };

    const handleAddedToChannel = (event: Event) => {
      if (event.channel) void addChannelToLists(event.channel);
    };

    const handleChannelActivity = (event: Event) => {
      // `notification.*` events carry a `channel`; `message.new` for a channel the
      // client is watching, which every open thread is, carries only its ids.
      const target =
        event.channel ??
        (event.channel_type && event.channel_id
          ? { type: event.channel_type, id: event.channel_id, cid: event.cid }
          : null);
      if (!target) return;
      const targetCid = target.cid || `${target.type}:${target.id}`;
      const isNewMessage =
        event.type === "message.new" ||
        event.type === "notification.message_new";
      // A message in a channel outside the loaded page: fetch and list it,
      // but only once the first page has landed (it replaces the lists).
      if (
        isNewMessage &&
        fetchedKeyRef.current !== null &&
        !listedCidsRef.current.has(targetCid)
      ) {
        // Listing needs the channel's data to check its scope, which only the
        // `channel` form of the event carries.
        if (event.channel) void addChannelToLists(event.channel);
        return;
      }
      const updatedChannel = client.channel(target.type, target.id);
      const updateList = (prev: Channel[]) =>
        sortUpdatedChannels(
          prev.map((ch) => (ch.cid === targetCid ? updatedChannel : ch)),
          targetCid,
          isNewMessage,
          event.message?.created_at,
        );

      if (target.type === "team") {
        setTeamChannels(updateList);
      } else if (target.type === "messaging") {
        setDirectMessages(updateList);
      }
    };

    const handleEvent = (event: Event) => {
      if (
        event.type === "notification.added_to_channel" &&
        event.channel &&
        event.user?.id === client.userID
      ) {
        handleAddedToChannel(event);
        return;
      }
      if (
        event.type === "channel.visible" &&
        event.channel &&
        event.user?.id === client.userID
      ) {
        handleAddedToChannel(event);
        return;
      }
      if (
        event.type === "notification.removed_from_channel" &&
        event.channel &&
        event.user?.id === client.userID
      ) {
        handleUserRemovedFromChannel(event.channel.cid || event.channel.id);
        return;
      }
      if (event.type === "channel.deleted" && event.channel) {
        handleChannelDeleted(event.channel.cid || event.channel.id);
        return;
      }
      if (
        (event.channel || event.channel_id) &&
        (event.type === "message.new" ||
          event.type === "notification.message_new" ||
          event.type === "message.read" ||
          event.type === "channel.updated")
      ) {
        handleChannelActivity(event);
      }
    };

    // #1280 2.6 — the SINGLE-argument form is the "every event" listener.
    client.on(handleEvent);

    return () => {
      disposed = true;
      client.off(handleEvent);
    };
  }, [client, handleChannelDeleted, handleUserRemovedFromChannel]);

  const handleChannelSelect = useCallback(
    (channel: Channel) => {
      // Use startTransition for non-urgent updates to improve perceived performance
      startTransition(() => {
        setActiveChannelId(channel.cid || null);
      });

      // Set active channel immediately for instant feedback
      setActiveChannel(channel);

      // Below `md` the conversation replaces this list (#1134). No-op above it.
      openConversation();
      markLinkUnavailable?.(null);

      // Mark channel as read asynchronously (only if channel is properly initialized)
      if (channel.initialized && channel.cid) {
        channel.markRead().catch(() => {
          // Silently ignore markRead errors - they can occur during rapid channel switching
        });
      }
    },
    [setActiveChannel, openConversation, markLinkUnavailable],
  );

  const handleTogglePin = useCallback(
    async (channel: Channel, pin: boolean) => {
      setPinOverrides((prev) => ({
        ...prev,
        [channel.cid]: pin ? new Date().toISOString() : null,
      }));
      const pending = pendingPinsRef.current;
      pending.set(channel.cid, (pending.get(channel.cid) ?? 0) + 1);
      try {
        await updateConversationPreference(channel, pin ? "pin" : "unpin");
      } catch {
        // Dropping the override puts back the value the list loaded with.
        setPinOverrides((prev) => {
          const { [channel.cid]: _undone, ...rest } = prev;
          return rest;
        });
        toast({
          title: "Could not update this conversation",
          description: "Please try again.",
          variant: "destructive",
        });
        return;
      } finally {
        const left = (pending.get(channel.cid) ?? 1) - 1;
        if (left > 0) pending.set(channel.cid, left);
        else pending.delete(channel.cid);
      }
      void rebaseList(listTypeOf(channel));
    },
    [toast, rebaseList],
  );

  // Hiding keeps the history; a new message or reopening it brings it back.
  const handleRemoveFromList = useCallback(
    async (channel: Channel) => {
      handleChannelDeleted(channel.cid);
      try {
        await updateConversationPreference(channel, "hide");
      } catch {
        void fetchChannels({ silent: true });
        toast({
          title: "Could not remove this conversation",
          description: "Please try again.",
          variant: "destructive",
        });
        return;
      }
      void rebaseList(listTypeOf(channel));
    },
    [handleChannelDeleted, fetchChannels, toast, rebaseList],
  );

  // A conversation opened from search or the New message picker is listed and
  // selected, so it is on screen when the person looks back at the list.
  const handleConversationOpened = useCallback((channel: Channel) => {
    const setList =
      channel.type === "team" ? setTeamChannels : setDirectMessages;
    setList((prev) => insertChannelAtTop(prev, channel));
    setActiveChannelId(channel.cid || null);
  }, []);

  // #248: keep activeChannelIdRef in lockstep with the state so the stable
  // handleChannelDeleted handler can read the current selection from the ref.
  useEffect(() => {
    activeChannelIdRef.current = activeChannelId;
  }, [activeChannelId]);

  // Open and select a channel when deep-linked via URL query parameters
  useEffect(() => {
    if (!client?.userID || !hasDeepLink) return;
    const pinnedOrgId = scopeOrgId(scope);
    const deepLinkKey = `${client.userID}::${counterpartyUserId ?? ""}::${deepLinkEventType ?? ""}::${deepLinkEventId ?? ""}::${deepLinkChannelId ?? ""}::${pinnedOrgId ?? "personal"}`;
    if (deepLinkHandledRef.current === deepLinkKey) return;
    deepLinkHandledRef.current = deepLinkKey;
    initialSelectionDoneRef.current = true;

    let cancelled = false;
    let completed = false;

    // `accessLost` only when the answer says the viewer may not open it; a network or server failure is neither.
    const failDeepLink = (description: string, accessLost = false) => {
      if (cancelled) return;
      completed = true;
      initialSelectionDoneRef.current = false;
      if (accessLost) {
        markLinkUnavailable?.(
          deepLinkEventType ||
            (deepLinkChannelId &&
              isEventChannel(
                parseDeepLinkChannelTarget(deepLinkChannelId).channelId,
              ))
            ? "event"
            : "conversation",
        );
        // Below `md` the explanation sits in the conversation pane.
        openConversation();
      }
      toast({
        title: "Unable to open conversation",
        description,
        variant: "destructive",
      });
    };

    const prependAndSelectChannel = (
      channel: Channel,
      targetList: "dm" | "team",
    ) => {
      deepLinkedChannelCidRef.current = channel.cid || null;
      const setter = targetList === "dm" ? setDirectMessages : setTeamChannels;
      setter((prev) =>
        prev.some((ch) => ch.cid === channel.cid) ? prev : [channel, ...prev],
      );
      completed = true;
      handleChannelSelect(channel);
    };

    const openViaEndpoint = async (
      payload: Record<string, unknown>,
      targetList: "dm" | "team",
    ) => {
      const response = await fetch("/api/stream/channels/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (cancelled) return;
      if (!response.ok) {
        const errBody = (await response.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        const message =
          typeof errBody?.error === "string"
            ? errBody.error
            : "Could not open the requested conversation.";
        failDeepLink(
          message,
          response.status === 403 || response.status === 404,
        );
        return;
      }
      const { channelType, channelId } = (await response.json()) as {
        channelType: "messaging" | "team";
        channelId: string;
      };
      const channel = client.channel(channelType, channelId);
      await channel.watch();
      if (cancelled) return;
      prependAndSelectChannel(channel, targetList);
    };

    const openByChannelId = async (rawChannelId: string, userId: string) => {
      const { channelType, channelId } =
        parseDeepLinkChannelTarget(rawChannelId);
      const found = await client.queryChannels(
        {
          type: channelType,
          id: { $eq: channelId },
          members: { $in: [userId] },
          ...buildOrgChannelFilter(scope),
        },
        { last_message_at: -1 },
        { watch: true, state: true, limit: 1 },
      );
      if (cancelled) return;
      if (found.length === 0) {
        failDeepLink("The requested conversation was not found.", true);
        return;
      }
      prependAndSelectChannel(
        found[0],
        channelType === "messaging" ? "dm" : "team",
      );
    };

    const openDeepLinkedChannel = async () => {
      try {
        if (counterpartyUserId) {
          await openViaEndpoint(
            {
              kind: "dm",
              counterpartyUserId,
              peerUserId: counterpartyUserId,
              organizationId: pinnedOrgId ?? null,
            },
            "dm",
          );
          return;
        }

        if (
          (deepLinkEventType === "webinar" || deepLinkEventType === "class") &&
          deepLinkEventId
        ) {
          await openViaEndpoint(
            {
              kind: "event",
              eventType: deepLinkEventType,
              eventId: deepLinkEventId,
            },
            "team",
          );
          return;
        }

        if (deepLinkChannelId && client.userID) {
          await openByChannelId(deepLinkChannelId, client.userID);
        }
      } catch (err) {
        console.error("Failed to open deep-linked channel:", err);
        failDeepLink("Failed to open the requested conversation.");
      }
    };

    void openDeepLinkedChannel();
    return () => {
      cancelled = true;
      if (!completed && deepLinkHandledRef.current === deepLinkKey) {
        deepLinkHandledRef.current = null;
        initialSelectionDoneRef.current = false;
      }
    };
  }, [
    client,
    hasDeepLink,
    counterpartyUserId,
    deepLinkEventType,
    deepLinkEventId,
    deepLinkChannelId,
    scope,
    handleChannelSelect,
    toast,
    markLinkUnavailable,
    openConversation,
  ]);

  // Debug Stream tools: local hostname only — never on deployed/preview hosts
  // even if NODE_ENV were somehow still "development".
  const [showLocalDebugTools, setShowLocalDebugTools] = useState(false);
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const host = window.location.hostname;
    setShowLocalDebugTools(host === "localhost" || host === "127.0.0.1");
  }, []);

  return (
    // Width belongs to ChatLayout now: full-bleed below `md`, a 320px column
    // above it. Hardcoding `w-80` here is what made mobile unusable (#1134).
    <div className="flex h-full w-full flex-col bg-card text-card-foreground md:border-r md:border-border">
      {/* Header with Title and Refresh */}
      <div className="p-4 border-b border-border flex justify-between items-center">
        <h1 className="text-xl font-bold">Chats</h1>
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleRefresh}
                disabled={isLoading}
                className="text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                <RefreshCwIcon
                  className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Refresh channels</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Search Bar */}
      <div className="p-4">
        <ChannelSearch
          scope={scope}
          onTermChange={setSearchTerm}
          listedChannelIds={listedChannelIds}
          onOpened={handleConversationOpened}
        />
      </div>

      {/* Channel Sections */}
      <div className="flex-1 overflow-y-auto">
        {/* Conversations come first: a client's message must never sit below a run of
            empty event channels. Not sticky: two `sticky top-0` headers in one scroll
            container pin to the same offset and overlap each other. */}
        <div className="flex items-center justify-between bg-card px-4 py-2">
          <h2 className="font-semibold">Conversations</h2>
          <NewMessageDialog scope={scope} onOpened={handleConversationOpened} />
        </div>
        {isLoading ? (
          <ChannelListSkeleton />
        ) : error ? (
          // Was an empty div on the theory that the Channels error above says
          // enough — so on failure this section just vanished.
          <div className="p-4 text-center text-sm text-destructive">
            <p>Conversations could not be loaded.</p>
          </div>
        ) : (
          // NOT `directMessages.length > 0 ? list : emptyState`.
          //
          // The list is filtered (phantom DMs are dropped, see
          // isUsableDmChannel) but `hasMoreDMChannels` is measured against the
          // RAW page length. So a page whose 20 rows are all phantoms leaves the
          // list empty with more pages still to come — and with the load-more
          // button living inside the non-empty branch, the empty state rendered
          // "No conversations yet" over a stranded list the user could not
          // reach. The button is now tied to `hasMoreDMChannels` alone, and the
          // empty state only claims there is nothing when there is genuinely
          // nothing left to fetch.
          <div>
            {visibleDirectMessages.map((channel) => (
              <ChannelItem
                key={channel.cid}
                channel={channel}
                isActive={channel.cid === activeChannelId}
                isPinned={Boolean(channelPinnedAt(channel, pinOverrides))}
                onClick={() => handleChannelSelect(channel)}
                onTogglePin={handleTogglePin}
                onRemove={handleRemoveFromList}
              />
            ))}

            {isFiltering && visibleDirectMessages.length === 0 && (
              <div className="p-4 text-center text-muted-foreground text-sm">
                {`No conversations match “${searchTerm.trim()}”.`}
              </div>
            )}

            {!isFiltering &&
              directMessages.length === 0 &&
              !hasMoreDMChannels && (
                <div className="p-4 text-center text-muted-foreground text-sm">
                  {noConversationsMessage(
                    Boolean(scopeOrgId(scope)),
                    isConsultant,
                  )}
                </div>
              )}

            {hasMoreDMChannels && !isFiltering && (
              <div className="p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => loadMoreChannels("messaging")}
                  disabled={isLoadingMore}
                  className="w-full text-muted-foreground hover:bg-muted text-sm"
                >
                  {isLoadingMore
                    ? "Loading..."
                    : directMessages.length === 0
                      ? "Load conversations"
                      : `Showing ${directMessages.length} conversations — Load more`}
                </Button>
              </div>
            )}
          </div>
        )}
        {/* Team Channels Section */}
        <div className="mt-4 px-4 py-2 flex justify-between items-center sticky top-0 bg-card z-10">
          <h2 className="font-semibold">Channels</h2>
          {canCreateChannels && (
            <CreateChannelDialog
              onChannelCreated={handleChannelCreated}
              // Custom (non-event) channels are admin/staff-only server-side.
              // Without this the option renders for consultants and every
              // submission 403s.
              canCreateCustomChannel={
                appRole === "ADMIN" || appRole === "STAFF"
              }
            />
          )}
        </div>
        {isLoading ? (
          <ChannelListSkeleton />
        ) : error ? (
          <div className="p-4 text-center text-sm text-destructive">
            <p>{error}</p>
            <Button
              onClick={handleRefresh}
              variant="secondary"
              size="sm"
              className="mt-2"
            >
              Try Again
            </Button>
          </div>
        ) : visibleTeamChannels.length > 0 ? (
          <div>
            {visibleTeamChannels.map((channel) => (
              <ChannelItem
                key={channel.cid}
                channel={channel}
                isActive={channel.cid === activeChannelId}
                isPinned={Boolean(channelPinnedAt(channel, pinOverrides))}
                onClick={() => handleChannelSelect(channel)}
                onTogglePin={handleTogglePin}
                onRemove={handleRemoveFromList}
              />
            ))}
            {hasMoreTeamChannels && !isFiltering && (
              <div className="p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => loadMoreChannels("team")}
                  disabled={isLoadingMore}
                  className="w-full text-muted-foreground hover:bg-muted text-sm"
                >
                  {isLoadingMore
                    ? "Loading..."
                    : `Showing ${teamChannels.length} channels — Load more`}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="p-4 text-center text-muted-foreground text-sm">
            {isFiltering
              ? `No channels match “${searchTerm.trim()}”.`
              : "No team channels found."}
          </div>
        )}
      </div>

      {/* Footer Section — Debug tools, localhost only */}
      {showLocalDebugTools && (
        <div className="mt-auto space-y-2 border-t border-border p-4">
          <InitializeUserChannelsButton
            userId={client?.userID || ""}
            className="w-full"
            onSuccess={handleRefresh}
          />
          <DebugDialog
            userId={client?.userID || ""}
            variant="ghost"
            className="w-full text-muted-foreground hover:bg-muted hover:text-foreground"
          />
        </div>
      )}
    </div>
  );
};
