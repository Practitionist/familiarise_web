"use client";

import { motion } from "framer-motion";
import { CalendarCheck } from "lucide-react";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { appointmentStatusChip } from "@/lib/appointments/occurrences";
import type { AppointmentActionAdapter } from "@/lib/appointments/adapter";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import {
  formatInViewerZone,
  zoneLabel,
  type ViewerZone,
} from "@/lib/time/viewer-zone";
import { CountdownBadge } from "./CountdownBadge";
import { RowPrimaryAction } from "./RowPrimaryAction";
import { KIND_LABEL } from "./AppointmentRow";
import { CounterpartAvatar } from "./CounterpartAvatar";

export interface HeroStat {
  label: string;
  value: number | string;
  /** Opens the tab the count belongs to. */
  onSelect?: () => void;
}

interface NextUpHeroProps {
  /** The next upcoming appointment, or null → slim "no upcoming" strip. */
  vm: AppointmentVM | null;
  adapter: AppointmentActionAdapter;
  /** Times render in this zone on the server and the client alike (hydration #418). */
  viewerZone: ViewerZone;
  stats: HeroStat[];
  onOpen?: (vm: AppointmentVM) => void;
}

export function NextUpHero({
  vm,
  adapter,
  viewerZone,
  stats,
  onOpen,
}: NextUpHeroProps) {
  if (!vm) {
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 shadow-sm">
        <CalendarCheck className="h-4 w-4 text-muted-foreground shrink-0" />
        <p className="text-sm text-muted-foreground flex-1">
          No upcoming sessions scheduled.
        </p>
        <StatChips stats={stats} />
      </div>
    );
  }

  const anchorSession = vm.nextAt
    ? vm.occurrences.find((s) => s.startsAt.getTime() === vm.nextAt?.getTime())
    : undefined;

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden"
    >
      <div className="flex flex-col lg:flex-row">
        <div className="flex-1 p-4 sm:p-5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Next appointment
          </p>
          <div className="flex items-start gap-4">
            <CounterpartAvatar
              counterpart={vm.counterpart}
              className="h-12 w-12 border border-border shrink-0"
              fallbackClassName="text-sm font-medium"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={onOpen ? () => onOpen(vm) : undefined}
                  className="font-semibold text-foreground text-base truncate hover:underline underline-offset-2 text-left"
                >
                  {vm.title}
                </button>
                <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground shrink-0">
                  {KIND_LABEL[vm.kind]}
                </span>
                <StatusBadge
                  {...appointmentStatusChip(vm, adapter.role)}
                  withDot
                  size="sm"
                />
              </div>
              {!vm.counterpart.audience && (
                <p className="text-sm text-muted-foreground mt-0.5 truncate">
                  with {vm.counterpart.name}
                </p>
              )}
              {vm.nextAt && (
                <div className="flex flex-wrap items-center gap-2 mt-2 text-sm">
                  <span className="font-medium text-foreground tabular-nums">
                    {formatInViewerZone(
                      vm.nextAt,
                      viewerZone.zone,
                      "EEE, d MMM · h:mm a",
                    )}
                    {anchorSession?.endsAt && (
                      <span className="text-muted-foreground font-normal">
                        {" – "}
                        {formatInViewerZone(
                          anchorSession.endsAt,
                          viewerZone.zone,
                          "h:mm a",
                        )}
                      </span>
                    )}
                    {!viewerZone.own && (
                      <span className="text-muted-foreground font-normal">
                        {" "}
                        {zoneLabel(vm.nextAt, viewerZone.zone)}
                      </span>
                    )}
                  </span>
                  <CountdownBadge
                    targetDate={vm.nextAt}
                    sessionEndDate={anchorSession?.endsAt ?? undefined}
                  />
                </div>
              )}
              <div className="mt-3">
                <RowPrimaryAction
                  action={adapter.primaryAction(vm)}
                  onView={onOpen ? () => onOpen(vm) : undefined}
                  size="default"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex lg:flex-col gap-px bg-border lg:w-48 border-t lg:border-t-0 lg:border-l border-border">
          <StatChips stats={stats} vertical />
        </div>
      </div>
    </motion.div>
  );
}

function StatChips({
  stats,
  vertical = false,
}: {
  stats: HeroStat[];
  vertical?: boolean;
}) {
  if (stats.length === 0) return null;
  return (
    <>
      {stats.map((stat) => {
        const body = vertical ? (
          <>
            <p className="text-lg font-semibold text-foreground tabular-nums">
              {stat.value}
            </p>
            <p className="text-[11px] text-muted-foreground">{stat.label}</p>
          </>
        ) : (
          <>
            <span className="text-sm font-semibold text-foreground tabular-nums mr-1">
              {stat.value}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {stat.label}
            </span>
          </>
        );
        const box = vertical
          ? "flex-1 bg-card px-4 py-3 text-left lg:py-0 lg:flex lg:flex-col lg:justify-center"
          : "text-right shrink-0 px-2";
        return stat.onSelect ? (
          <button
            key={stat.label}
            type="button"
            onClick={stat.onSelect}
            className={`${box} rounded-md hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
          >
            {body}
          </button>
        ) : (
          <div key={stat.label} className={box}>
            {body}
          </div>
        );
      })}
    </>
  );
}
