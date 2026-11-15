"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  useCallback,
} from "react";
import { useSearchParams } from "next/navigation";
import { CalendarDays, List } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSession } from "@/lib/auth-client";
import { resolveSponsoringOrgName } from "@/lib/labels/session-labels";
import type {
  AppointmentActionAdapter,
  AppointmentChatTarget,
} from "@/lib/appointments/adapter";
import {
  CONSULTANT_JOIN_WINDOW_MS,
  CONSULTEE_JOIN_WINDOW_MS,
} from "@/lib/appointments/occurrences";
import type {
  AppointmentBucket,
  AppointmentVM,
} from "@/lib/appointments/view-model";
import type { ViewerZone } from "@/lib/time/viewer-zone";
import { cn } from "@/utils/tailwind";
import { replaceUrl } from "@/lib/navigation/history";
import { AppointmentCalendar } from "./AppointmentCalendar";
import { AppointmentList } from "./AppointmentList";
import { AppointmentSheet } from "./AppointmentSheet";
import { LazyAppointmentChatSheet } from "./LazyAppointmentChatSheet";
import {
  AppointmentsFilterBar,
  matchesTypeFilter,
  type DateRange,
  type TypeFilter,
} from "./AppointmentsFilterBar";
import {
  dateRangeToInstants,
  type DateRangeDirection,
} from "@/components/dashboard/DateRangeMenu";
import { NextUpHero, type HeroStat } from "./NextUpHero";

type TabValue = AppointmentBucket | "all";
type Viewer = "consultant" | "consultee";
type View = "list" | "calendar";

/**
 * Per-viewer tabs (#1527 §13b). The consultee's pending requests wait on the
 * expert, so they get their own tab instead of "Needs you"; the consultant's
 * pre-confirmation work lives in Requests and only appears under All.
 * "All" leads where it exists, matching the filter bar's "All types" chip.
 */
const TABS: Record<Viewer, Array<{ value: TabValue; label: string }>> = {
  consultee: [
    { value: "upcoming", label: "Upcoming" },
    { value: "needsAction", label: "Needs you" },
    { value: "waiting", label: "Waiting on expert" },
    { value: "past", label: "Past" },
    { value: "cancelled", label: "Cancelled" },
  ],
  consultant: [
    { value: "all", label: "All" },
    { value: "upcoming", label: "Upcoming" },
    { value: "needsAction", label: "Needs action" },
    { value: "past", label: "Past" },
    { value: "cancelled", label: "Cancelled" },
  ],
};

type EmptyCopy = { title: string; description: string };

/** Each tab's empty state, worded for the learner or the expert. */
const EMPTY_COPY: Record<TabValue, Record<Viewer, EmptyCopy>> = {
  upcoming: {
    consultee: {
      title: "No upcoming appointments",
      description: "Sessions you book will show up here.",
    },
    consultant: {
      title: "No upcoming sessions",
      description: "Sessions learners book with you will show up here.",
    },
  },
  needsAction: {
    consultee: {
      title: "Nothing needs you",
      description: "Payments and scheduling tasks will collect here.",
    },
    consultant: {
      title: "Nothing needs action",
      description:
        "Confirmed bookings that still need scheduling collect here. New requests live in Requests.",
    },
  },
  waiting: {
    consultee: {
      title: "Nothing waiting on an expert",
      description: "Requests you send stay here until the expert answers.",
    },
    consultant: {
      title: "Nothing waiting",
      description: "Requests waiting on you live in Requests.",
    },
  },
  inRequests: {
    consultee: {
      title: "No requests",
      description: "Requests you send stay here until the expert answers.",
    },
    consultant: {
      title: "No requests",
      description: "Requests waiting on you live in Requests.",
    },
  },
  past: {
    consultee: {
      title: "No past appointments",
      description: "Sessions you have attended will appear here.",
    },
    consultant: {
      title: "No past sessions",
      description: "Sessions you have delivered will appear here.",
    },
  },
  cancelled: {
    consultee: {
      title: "No cancelled appointments",
      description:
        "Bookings that ended without their session, and why, will appear here.",
    },
    consultant: {
      title: "No cancelled sessions",
      description:
        "Bookings that ended without their session, and why, will appear here.",
    },
  },
  all: {
    consultee: {
      title: "No appointments found",
      description:
        "Try clearing the filters, or book a session to get started.",
    },
    consultant: {
      title: "No sessions found",
      description: "Try clearing the filters.",
    },
  },
};

function emptyCopyOf(value: TabValue, viewer: Viewer): EmptyCopy {
  return EMPTY_COPY[value][viewer];
}

/** `?tab=` → a tab this viewer has; legacy values land somewhere sensible. */
function resolveTab(param: string | null, viewer: Viewer): TabValue {
  const tabs = TABS[viewer];
  const known = tabs.find((t) => t.value === param);
  if (known) return known.value;
  // Old BookingHistoryTab deep-links: the consultee has no All tab now.
  if (param === "history" || param === "all") {
    return viewer === "consultant" ? "all" : "past";
  }
  return "upcoming";
}

/**
 * Mirror a param into the address bar without a soft navigation (same
 * approach as UrlTabs): a shareable URL, no RSC refetch, no history entry.
 */
function replaceQueryParam(name: string, value: string) {
  const url = new URL(window.location.href);
  url.searchParams.set(name, value);
  const target = url.pathname + url.search + url.hash;
  const current =
    window.location.pathname + window.location.search + window.location.hash;
  if (target !== current) {
    replaceUrl(target);
  }
}

/** Date presets look forward on the to-do tabs and back on the done ones. */
function dateDirectionOf(tab: TabValue, view: View): DateRangeDirection {
  if (view === "calendar" || tab === "all") return "any";
  return tab === "past" || tab === "cancelled" ? "past" : "future";
}

interface AppointmentsShellProps {
  vms: AppointmentVM[];
  adapter: AppointmentActionAdapter;
  /** From the RSC page's session, so the server render and the hydrating
   *  client format every time from one zone (hydration #418). */
  viewerZone: ViewerZone;
  orgFilterSlot?: ReactNode;
  /** Side-query error/retry banners (consultant trials/unscheduled). */
  notices?: ReactNode;
  /** Row id (VM id) to flash + scroll to (consultant ?highlight= deep-link). */
  highlightedId?: string | null;
  /** Consultant Requests URL — "In Requests" chips on pre-confirmation rows. */
  requestsHref?: string;
  /** Under the bucket tabs: the consultant's window notice + "Load older". */
  footer?: ReactNode;
  /** A compact strip right under the next appointment (the learner's alerts). */
  afterHero?: ReactNode;
}

export function AppointmentsShell({
  vms,
  adapter,
  viewerZone,
  orgFilterSlot,
  notices,
  highlightedId = null,
  requestsHref,
  footer,
  afterHero,
}: AppointmentsShellProps) {
  const searchParams = useSearchParams();
  const { data: session } = useSession();
  const viewer: Viewer =
    adapter.role === "consultant" ? "consultant" : "consultee";
  const tabs = TABS[viewer];

  // #1527 — tab and view live in the URL (?tab=, ?view=); they were read once.
  // A local pick applies instantly; an external URL change wins over it.
  const requestedTab = searchParams?.get("tab") ?? null;
  const requestedView = searchParams?.get("view") ?? null;
  const [localTab, setLocalTab] = useState<TabValue | null>(null);
  const [localView, setLocalView] = useState<View | null>(null);
  useEffect(() => {
    setLocalTab(null);
  }, [requestedTab]);
  useEffect(() => {
    setLocalView(null);
  }, [requestedView]);
  const tab = localTab ?? resolveTab(requestedTab, viewer);
  // Legacy consultee ?tab=calendar deep-links land on the calendar view.
  const urlView: View =
    requestedView === "calendar" || requestedTab === "calendar"
      ? "calendar"
      : "list";
  const view = localView ?? urlView;
  const setTab = useCallback(
    (value: string) => {
      const next = resolveTab(value, viewer);
      setLocalTab(next);
      replaceQueryParam("tab", next);
    },
    [viewer],
  );
  const setView = useCallback((value: View) => {
    setLocalView(value);
    replaceQueryParam("view", value);
  }, []);
  const [sheetVm, setSheetVm] = useState<AppointmentVM | null>(null);
  const [chatTarget, setChatTarget] = useState<AppointmentChatTarget | null>(
    null,
  );
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("ALL");
  const [search, setSearch] = useState("");
  const [dateRange, setDateRange] = useState<DateRange>({ from: "", to: "" });
  const [flashId, setFlashId] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Highlight deep-link: flash + scroll the row once it exists in the DOM.
  useEffect(() => {
    if (!highlightedId) return;
    setFlashId(highlightedId);
    const scrollTimer = setTimeout(() => {
      rowRefs.current
        .get(highlightedId)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 150);
    const clearTimer = setTimeout(() => setFlashId(null), 3000);
    return () => {
      clearTimeout(scrollTimer);
      clearTimeout(clearTimer);
    };
  }, [highlightedId]);

  const orgMemberships = session?.user?.organizationMemberships ?? [];
  const resolveSponsoredLabel = (orgId: string | null) =>
    resolveSponsoringOrgName(orgId, orgMemberships);

  // Type/search/date filters apply to every tab (counts included) so the tab
  // numbers always describe what the user would see on click.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const bounds = dateRangeToInstants(dateRange);
    const fromMs = bounds.from?.getTime() ?? null;
    const toMs = bounds.to?.getTime() ?? null;
    return vms.filter((vm) => {
      if (!matchesTypeFilter(vm.kind, typeFilter)) return false;
      if (
        q &&
        !vm.title.toLowerCase().includes(q) &&
        !vm.counterpart.name.toLowerCase().includes(q)
      ) {
        return false;
      }
      if (fromMs !== null || toMs !== null) {
        const t = vm.nextAt?.getTime();
        if (t === undefined) return false;
        if (fromMs !== null && t < fromMs) return false;
        if (toMs !== null && t > toMs) return false;
      }
      return true;
    });
  }, [vms, typeFilter, search, dateRange]);

  const byBucket = useMemo(() => {
    const map: Record<AppointmentBucket, AppointmentVM[]> = {
      upcoming: [],
      needsAction: [],
      waiting: [],
      inRequests: [],
      past: [],
      cancelled: [],
    };
    for (const vm of filtered) map[vm.bucket].push(vm);
    return map;
  }, [filtered]);

  const countOf = (value: TabValue) =>
    value === "all" ? filtered.length : byBucket[value].length;

  // Hero reads the UNFILTERED list — it answers "what's next", not "what's
  // next among the current filters". A row only qualifies while its anchor
  // session hasn't ended (live sessions stay; an elapsed pending booking in
  // Needs action is not "next"). Requests-owned rows are not "next" either.
  const heroVm = useMemo(() => {
    const now = Date.now();
    const candidates = vms.filter((vm) => {
      if (
        vm.bucket !== "upcoming" &&
        vm.bucket !== "needsAction" &&
        vm.bucket !== "waiting"
      )
        return false;
      if (!vm.nextAt) return false;
      const anchor = vm.occurrences.find(
        (s) => s.startsAt.getTime() === vm.nextAt?.getTime(),
      );
      const end =
        anchor?.endsAt?.getTime() ?? vm.nextAt.getTime() + 60 * 60 * 1000;
      return end >= now;
    });
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) =>
      (a.nextAt as Date).getTime() <= (b.nextAt as Date).getTime() ? a : b,
    );
  }, [vms]);

  // The count is over every booking, so its tab opens as a list with no filter hiding them.
  const openNeedsAction = useCallback(() => {
    setTypeFilter("ALL");
    setSearch("");
    setDateRange({ from: "", to: "" });
    setView("list");
    setTab("needsAction");
  }, [setTab, setView]);
  const stats: HeroStat[] = useMemo(() => {
    const weekEnd = Date.now() + 7 * 86_400_000;
    const thisWeek = vms.filter(
      (vm) =>
        vm.bucket !== "cancelled" &&
        vm.bucket !== "past" &&
        vm.nextAt !== null &&
        vm.nextAt.getTime() <= weekEnd &&
        vm.nextAt.getTime() >= Date.now() - 60 * 60 * 1000,
    ).length;
    const needsAction = vms.filter((vm) => vm.bucket === "needsAction").length;
    return [
      { value: thisWeek, label: "sessions this week" },
      {
        value: needsAction,
        label: "need action",
        onSelect: openNeedsAction,
      },
    ];
  }, [vms, openNeedsAction]);

  // Row/hero/calendar click → the summary Sheet. Track by id so the sheet
  // re-renders fresh data after a mutation invalidates the list query.
  const openVm = (vm: AppointmentVM) => setSheetVm(vm);
  const activeSheetVm = sheetVm
    ? (vms.find((vm) => vm.id === sheetVm.id) ?? null)
    : null;
  const joinWindowMs =
    adapter.role === "consultant"
      ? CONSULTANT_JOIN_WINDOW_MS
      : CONSULTEE_JOIN_WINDOW_MS;

  return (
    <div className="space-y-5">
      <NextUpHero
        vm={heroVm}
        adapter={adapter}
        viewerZone={viewerZone}
        stats={stats}
        onOpen={openVm}
      />
      {afterHero}

      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <TabsList
            className={cn(
              "flex-wrap h-auto",
              view === "calendar" && "opacity-60",
            )}
          >
            {tabs.map(({ value, label }) => {
              const count = countOf(value);
              // Work waiting on the viewer stands out; an empty tab recedes.
              const urgent = value === "needsAction" && count > 0;
              return (
                <TabsTrigger
                  key={value}
                  value={value}
                  className={cn(
                    "gap-1.5",
                    // The calendar already dims the whole list.
                    view === "list" &&
                      count === 0 &&
                      value !== tab &&
                      "opacity-60",
                  )}
                >
                  {label}
                  <span
                    className={cn(
                      "text-[10px] tabular-nums",
                      urgent
                        ? "font-bold text-destructive"
                        : "text-muted-foreground",
                    )}
                  >
                    {count}
                  </span>
                </TabsTrigger>
              );
            })}
          </TabsList>

          {/* List / calendar view toggle */}
          <div
            className={cn(
              "flex items-center rounded-lg border border-border bg-card p-0.5",
            )}
          >
            {(
              [
                { value: "list", label: "List", icon: List },
                { value: "calendar", label: "Calendar", icon: CalendarDays },
              ] as const
            ).map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setView(value)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  view === value
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
                aria-pressed={view === value}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <AppointmentsFilterBar
            typeFilter={typeFilter}
            onTypeChange={setTypeFilter}
            search={search}
            onSearchChange={setSearch}
            dateRange={dateRange}
            onDateRangeChange={setDateRange}
            dateDirection={dateDirectionOf(tab, view)}
            orgFilterSlot={orgFilterSlot}
          />
        </div>

        {notices && <div className="mt-4">{notices}</div>}
        {footer}

        {view === "calendar" ? (
          <div className="mt-4">
            <AppointmentCalendar vms={filtered} onSelect={openVm} />
          </div>
        ) : (
          tabs.map(({ value }) => (
            <TabsContent key={value} value={value} className="mt-4">
              <AppointmentList
                vms={value === "all" ? filtered : byBucket[value]}
                bucket={value}
                requestsHref={requestsHref}
                adapter={adapter}
                viewerZone={viewerZone}
                resolveSponsoredLabel={resolveSponsoredLabel}
                onOpen={openVm}
                highlightedId={flashId}
                registerRowRef={(id, el) => {
                  if (el) rowRefs.current.set(id, el);
                  else rowRefs.current.delete(id);
                }}
                emptyTitle={emptyCopyOf(value, viewer).title}
                emptyDescription={emptyCopyOf(value, viewer).description}
              />
            </TabsContent>
          ))
        )}
      </Tabs>

      <AppointmentSheet
        vm={activeSheetVm}
        onOpenChange={(open) => !open && setSheetVm(null)}
        adapter={adapter}
        sponsoredLabel={
          activeSheetVm
            ? resolveSponsoredLabel(activeSheetVm.organizationId)
            : null
        }
        joinWindowMs={joinWindowMs}
        onOpenChat={(target) => {
          // One sheet at a time: the quick view closes as the chat opens.
          setSheetVm(null);
          setChatTarget(target);
        }}
      />
      <LazyAppointmentChatSheet
        target={chatTarget}
        onClose={() => setChatTarget(null)}
      />

      {adapter.renderDialogs()}
    </div>
  );
}
