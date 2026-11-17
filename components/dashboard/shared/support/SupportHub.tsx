"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Inbox } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { ErrorState } from "@/components/dashboard/ErrorState";
import { FilterBar } from "@/components/dashboard/FilterBar";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { TablePagination } from "@/components/dashboard/TablePagination";
import { useListParams } from "@/hooks/useListParams";
import { useSession } from "@/lib/auth-client";
import { caseKeyOf } from "@/lib/support/case-key";
import { throwSupportError } from "@/lib/support/error-copy";
import { supportKeys } from "@/lib/support/support-keys";
import { CreateTicketDialog } from "./CreateTicketDialog";
import { humanizeEnum, type Tone } from "@/lib/ui/tone";
import { useZoneClock } from "@/lib/time/use-zone-clock";

const Cases = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      referenceNumber: z.string().nullable(),
      status: z.string(),
      appointmentId: z.string().nullable(),
      lastMessageAt: z.string(),
      organization: z.object({ id: z.string(), name: z.string() }).nullable(),
    }),
  ),
  pagination: z.object({
    page: z.number(),
    pageSize: z.number(),
    total: z.number(),
  }),
});
const Plan = z.object({ title: z.string().nullish() });
const Appointments = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      appointmentType: z.string().optional(),
      consultation: z.object({ consultationPlan: Plan.nullish() }).nullish(),
      subscription: z.object({ subscriptionPlan: Plan.nullish() }).nullish(),
      webinar: z.object({ webinarPlan: Plan.nullish() }).nullish(),
      class: z.object({ classPlan: Plan.nullish() }).nullish(),
      occurrences: z.array(z.object({ startsAt: z.string() })).optional(),
      organization: z.object({ name: z.string() }).nullish(),
    }),
  ),
});
const STATUS_TONES: Record<string, Tone> = {
  OPEN: "caution",
  IN_PROGRESS: "info",
  ESCALATED: "info",
  RESOLVED: "success",
  CLOSED: "neutral",
};

type PickerAppointment = z.infer<typeof Appointments>["items"][number];

/** Upcoming occurrences soonest first, then past ones most recent first. */
export function byRelevantOccurrence(
  items: PickerAppointment[],
  now: number,
): { appointment: PickerAppointment; startsAt: string | undefined }[] {
  const ranked = items.map((appointment) => {
    const times = (appointment.occurrences ?? [])
      .map((o) => new Date(o.startsAt).getTime())
      .filter((t) => Number.isFinite(t));
    const upcoming = times.filter((t) => t >= now);
    const at = upcoming.length > 0 ? Math.min(...upcoming) : Math.max(...times);
    return {
      appointment,
      at: Number.isFinite(at) ? at : null,
      upcoming: upcoming.length > 0,
    };
  });
  ranked.sort((a, b) => {
    if (a.at === null || b.at === null) return a.at === null ? 1 : -1;
    if (a.upcoming !== b.upcoming) return a.upcoming ? -1 : 1;
    return a.upcoming ? a.at - b.at : b.at - a.at;
  });
  return ranked.map(({ appointment, at }) => ({
    appointment,
    startsAt: at === null ? undefined : new Date(at).toISOString(),
  }));
}

/** One personal inbox; appointment descriptions use booking facts rather than generated summaries. */
export function SupportHub({
  requestsBase,
  appointmentsHref,
}: Readonly<{ requestsBase: string; appointmentsHref?: string }>) {
  const { data: session } = useSession();
  const list = useListParams<"context" | "status">({
    filterKeys: ["context", "status"],
  });
  const [pickAppointment, setPickAppointment] = useState(false);
  // The viewer's zone, pinned by the page's DisplayZoneProvider.
  const clock = useZoneClock();
  const context = list.filters.context;
  const status = list.filters.status;
  const query = useQuery({
    queryKey: supportKeys.requestList(session?.user.id, {
      page: list.page,
      context,
      status,
    }),
    enabled: Boolean(session?.user.id),
    refetchOnMount: "always",
    queryFn: async () => {
      const params = new URLSearchParams({
        ownership: "personal",
        page: String(list.page),
      });
      if (context) params.set("scope", context);
      if (status) params.set("status", status);
      const response = await fetch(`/api/support/requests?${params}`);
      if (!response.ok) await throwSupportError(response, "requests load");
      return Cases.parse(await response.json());
    },
  });
  const appointments = useQuery({
    queryKey: supportKeys.appointmentPicker(session?.user.id),
    enabled: pickAppointment && Boolean(session?.user.id),
    queryFn: async () => {
      const response = await fetch("/api/appointments?pageSize=20");
      if (!response.ok) await throwSupportError(response, "appointments load");
      return byRelevantOccurrence(
        Appointments.parse(await response.json()).items,
        Date.now(),
      ).slice(0, 8);
    },
  });
  const requestHref = (id: string) =>
    `${requestsBase}/${caseKeyOf({ kind: "case", id })}`;
  let appointmentContent: ReactNode;
  if (!pickAppointment) {
    appointmentContent = null;
  } else if (appointments.isPending) {
    appointmentContent = <Skeleton className="h-20 w-full" />;
  } else if (appointments.isError) {
    appointmentContent = (
      <ErrorState
        title="Couldn't load appointments"
        onRetry={() => void appointments.refetch()}
      />
    );
  } else if (appointments.data.length === 0) {
    appointmentContent = (
      <p className="text-sm text-muted-foreground">No appointments yet.</p>
    );
  } else {
    appointmentContent = (
      <ul className="divide-y divide-border">
        {appointments.data.map(({ appointment: a, startsAt }) => {
          const title =
            a.consultation?.consultationPlan?.title ??
            a.subscription?.subscriptionPlan?.title ??
            a.webinar?.webinarPlan?.title ??
            a.class?.classPlan?.title ??
            "Appointment";
          return (
            <li
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div>
                <p className="text-sm font-medium">{title}</p>
                <p className="text-xs text-muted-foreground">
                  {[
                    startsAt ? clock.dateTime(startsAt) : "Time not set",
                    a.appointmentType ? humanizeEnum(a.appointmentType) : null,
                    a.organization?.name,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <Button size="sm" variant="outline" asChild>
                <Link
                  href={`${requestsBase}/${caseKeyOf({ kind: "booking", id: a.id })}`}
                >
                  Get help
                </Link>
              </Button>
            </li>
          );
        })}
      </ul>
    );
  }
  let requestList: ReactNode;
  if (query.isPending) {
    requestList = <Skeleton className="h-40 w-full" />;
  } else if (query.isError) {
    requestList = (
      <ErrorState
        title="Couldn't load your support cases"
        onRetry={() => void query.refetch()}
      />
    );
  } else if (query.data.data.length === 0) {
    requestList = (
      <EmptyState
        icon={Inbox}
        title={
          context || status
            ? "No support cases match these filters"
            : "No support cases yet"
        }
        description="Support cases you raise personally appear here. Organization-owned cases stay in that organization’s Help & support area."
      />
    );
  } else {
    requestList = (
      <ul className="divide-y divide-border rounded-lg border border-border">
        {query.data.data.map((row) => (
          <li key={row.id}>
            <Link
              href={requestHref(row.id)}
              className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 transition-colors hover:bg-muted/50"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{row.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {[
                    row.referenceNumber,
                    row.appointmentId ? "Appointment" : "Account & platform",
                    row.organization?.name,
                    `Updated ${clock.dateTime(row.lastMessageAt)}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <StatusBadge
                label={humanizeEnum(row.status)}
                tone={STATUS_TONES[row.status] ?? "neutral"}
                size="sm"
              />
            </Link>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <CreateTicketDialog
          requestHref={(id) =>
            `/dashboard/support/${caseKeyOf({ kind: "case", id })}`
          }
        />
        {appointmentsHref && (
          <Button
            variant="outline"
            onClick={() => setPickAppointment(!pickAppointment)}
            aria-expanded={pickAppointment}
            aria-controls="support-appointment-picker"
          >
            <CalendarDays className="mr-2 h-4 w-4" aria-hidden />
            Get help with an appointment
          </Button>
        )}
      </div>
      {pickAppointment && (
        <section
          id="support-appointment-picker"
          className="space-y-3 rounded-lg border border-border p-4"
        >
          <h3 className="text-sm font-semibold">Choose an appointment</h3>
          {appointmentContent}
          <p className="text-sm text-muted-foreground">
            Looking for another booking?{" "}
            <Link
              className="underline underline-offset-4"
              href={appointmentsHref ?? "/dashboard"}
            >
              View all appointments
            </Link>
          </p>
        </section>
      )}
      <FilterBar
        selects={[
          {
            key: "context",
            label: "Context",
            value: context ?? "all",
            options: [
              { value: "all", label: "All contexts" },
              { value: "session", label: "Appointments" },
              { value: "platform", label: "Account & platform" },
            ],
            onChange: (value) =>
              list.setFilter("context", value === "all" ? null : value),
          },
          {
            key: "status",
            label: "Status",
            value: status ?? "all",
            options: [
              { value: "all", label: "All statuses" },
              ...Object.keys(STATUS_TONES).map((value) => ({
                value,
                label: humanizeEnum(value),
              })),
            ],
            onChange: (value) =>
              list.setFilter("status", value === "all" ? null : value),
          },
        ]}
        canClear={Boolean(context || status)}
        onClear={list.clear}
      />
      {requestList}
      {query.data &&
        query.data.pagination.total > query.data.pagination.pageSize && (
          <TablePagination
            page={query.data.pagination.page}
            pageSize={query.data.pagination.pageSize}
            total={query.data.pagination.total}
            onPageChange={list.setPage}
          />
        )}
    </div>
  );
}
