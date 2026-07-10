"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSession } from "@/lib/auth-client";
import { resolveSponsoringOrgName } from "@/lib/labels/session-labels";
import type { AppointmentActionAdapter } from "@/lib/appointments/adapter";
import type {
  AppointmentBucket,
  AppointmentVM,
} from "@/lib/appointments/view-model";
import { AppointmentList } from "./AppointmentList";
import {
  AppointmentsFilterBar,
  matchesTypeFilter,
  type DateRange,
  type TypeFilter,
} from "./AppointmentsFilterBar";
import { NextUpHero, type HeroStat } from "./NextUpHero";

type TabValue = AppointmentBucket | "all";

const TABS: Array<{ value: TabValue; label: string }> = [
  { value: "upcoming", label: "Upcoming" },
  { value: "needsAction", label: "Needs action" },
  { value: "past", label: "Past" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "All" },
];

const EMPTY_COPY: Record<TabValue, { title: string; description: string }> = {
  upcoming: {
    title: "No upcoming appointments",
    description: "Sessions you book will show up here.",
  },
  needsAction: {
    title: "Nothing needs your attention",
    description:
      "Payments, approvals, and scheduling tasks will collect here.",
  },
  past: {
    title: "No past appointments",
    description: "Completed sessions will appear here.",
  },
  cancelled: {
    title: "No cancelled appointments",
    description: "Cancelled or rejected bookings will appear here.",
  },
  all: {
    title: "No appointments found",
    description: "Try clearing the filters, or book a session to get started.",
  },
};

/** Legacy deep-link values from the old consultee tabs. */
function initialTab(param: string | null): TabValue {
  switch (param) {
    case "past":
      return "past";
    case "cancelled":
      return "cancelled";
    case "all":
    case "history": // old BookingHistoryTab deep-links land on All
      return "all";
    case "needsAction":
      return "needsAction";
    default:
      return "upcoming";
  }
}

interface AppointmentsShellProps {
  vms: AppointmentVM[];
  adapter: AppointmentActionAdapter;
  orgFilterSlot?: ReactNode;
  /** Side-query error/retry banners (consultant trials/unscheduled). */
  notices?: ReactNode;
  /** Row id (VM id) to flash + scroll to (consultant ?highlight= deep-link). */
  highlightedId?: string | null;
}

export function AppointmentsShell({
  vms,
  adapter,
  orgFilterSlot,
  notices,
  highlightedId = null,
}: AppointmentsShellProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();

  const [tab, setTab] = useState<TabValue>(() =>
    initialTab(searchParams?.get("tab") ?? null),
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

  // Chip/search/date filters apply to every tab (counts included) so the tab
  // numbers always describe what the user would see on click.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromMs = dateRange.from ? new Date(dateRange.from).getTime() : null;
    const toMs = dateRange.to
      ? new Date(dateRange.to).getTime() + 86_400_000 - 1
      : null;
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
      past: [],
      cancelled: [],
    };
    for (const vm of filtered) map[vm.bucket].push(vm);
    return map;
  }, [filtered]);

  const countOf = (value: TabValue) =>
    value === "all" ? filtered.length : byBucket[value].length;

  // Hero reads the UNFILTERED list — it answers "what's next", not "what's
  // next among the current filters".
  const heroVm = useMemo(() => {
    const candidates = vms.filter(
      (vm) =>
        (vm.bucket === "upcoming" || vm.bucket === "needsAction") &&
        vm.nextAt !== null,
    );
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) =>
      (a.nextAt as Date).getTime() <= (b.nextAt as Date).getTime() ? a : b,
    );
  }, [vms]);

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
      { value: needsAction, label: "need action" },
    ];
  }, [vms]);

  // Row/hero click target: the detail page when one exists (Sheet arrives as
  // the primary target in the next chunk).
  const openVm = (vm: AppointmentVM) => {
    const href = adapter.detailHref(vm);
    if (href) router.push(href);
  };
  const canOpen = (vm: AppointmentVM) => adapter.detailHref(vm) !== null;

  return (
    <div className="space-y-5">
      <NextUpHero vm={heroVm} adapter={adapter} stats={stats} onOpen={openVm} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <TabsList className="flex-wrap h-auto">
            {TABS.map(({ value, label }) => (
              <TabsTrigger key={value} value={value} className="gap-1.5">
                {label}
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {countOf(value)}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <div className="mt-4">
          <AppointmentsFilterBar
            typeFilter={typeFilter}
            onTypeChange={setTypeFilter}
            search={search}
            onSearchChange={setSearch}
            dateRange={dateRange}
            onDateRangeChange={setDateRange}
            orgFilterSlot={orgFilterSlot}
          />
        </div>

        {notices && <div className="mt-4">{notices}</div>}

        {TABS.map(({ value }) => (
          <TabsContent key={value} value={value} className="mt-4">
            <AppointmentList
              vms={value === "all" ? filtered : byBucket[value]}
              bucket={value}
              adapter={adapter}
              resolveSponsoredLabel={resolveSponsoredLabel}
              onOpen={openVm}
              canOpen={canOpen}
              highlightedId={flashId}
              registerRowRef={(id, el) => {
                if (el) rowRefs.current.set(id, el);
                else rowRefs.current.delete(id);
              }}
              emptyTitle={EMPTY_COPY[value].title}
              emptyDescription={EMPTY_COPY[value].description}
            />
          </TabsContent>
        ))}
      </Tabs>

      {adapter.renderDialogs()}
    </div>
  );
}
