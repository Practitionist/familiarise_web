// The read-only availability search. It takes the base client, so it runs
// outside the write transaction, under the caller's locks.

import { MINIMUM_BOOKING_LEAD_TIME_MS } from "@/lib/payments/constants";
import type { PrismaLike } from "@/lib/prisma";
import { Prisma, ScheduleType } from "@prisma/client";
import { addMonths } from "date-fns";
import {
  EventType,
  ConsultantAllocationData,
  EventConfig,
} from "@/utils/scheduling-engine/types";
import { ScheduleCalculationService } from "@/utils/scheduling-engine/ScheduleCalculationService";
import {
  intervalStartsOf,
  isDeadOccurrence,
  SCHEDULING_INTERVAL_MS,
} from "@/lib/appointments/occurrences";
import {
  matchesPreferredDays,
  maxPreferenceScore,
  type AllocationPreference,
} from "@/utils/scheduling-engine/preferenceScoring";
import { isOccupiedByLiveAppointment } from "@/utils/scheduling-engine/ScheduleValidationService";
import {
  buildConsultantOccupancyWhere,
  buildOccupiedAppointmentFilter,
  OCCUPYING_OCCURRENCE_WHERE,
  timeHoldingParticipant,
} from "@/utils/scheduling-engine/occupancyPolicy";
import {
  MAX_CLASS_SESSIONS_PER_DAY,
  MAX_SUBSCRIPTION_SESSIONS_PER_DAY,
} from "@/utils/scheduling-engine/sessionCaps";
import {
  createSearchBudget,
  type SearchBudget,
} from "@/utils/scheduling-engine/availability-search";
import {
  partitionWeeklyRows,
  weeklyRowIntervalsInRange,
} from "@/utils/schedule/weekly-projection";
import { reportIncompleteWeeklyRows } from "@/lib/scheduling/incomplete-weekly-rows";
import {
  AllocationValidationError,
  SlotShortageError,
  SearchTimeoutError,
} from "@/utils/scheduling-engine/errors";
import {
  customSpansInStartOrder,
  sortWeeklyByNextOccurrence,
} from "@/lib/booking/allocation/search/recurrence";
import {
  DAY_MS,
  ALLOCATOR_SEARCH_TIME_BUDGET_MS,
  type AllocationWalkContext,
  type RowSpan,
} from "@/lib/booking/allocation/search/constants";
import {
  projectableWeeklyRows,
  reportSearchBudgetSpent,
} from "@/lib/booking/allocation/search/window-walk";
import {
  bestFittingBlockInRow,
  bestBlockForSingleSession,
} from "@/lib/booking/allocation/search/blocks";
import type { AppointmentWithSlots } from "@/lib/booking/allocation/types";

/** How a sweep may place: spread with a free day between, one a day, or up to the per-day cap. */
type Spacing = "spaced" | "onePerDay" | "packed";

/**
 * Find available consecutive slots for auto-allocation.
 *
 * #1065 — `preference` orders the candidates that are already valid. Every
 * hard constraint (availability, both parties' bookings, per-day and per-week
 * caps, the scheduling period) is evaluated exactly as before and no
 * preference can relax or tighten one. An unsatisfiable preference therefore
 * changes nothing except which of the equally-legal placements is chosen.
 *
 * The search runs under `ALLOCATOR_SEARCH_TIME_BUDGET_MS`. Spending it ends
 * the walk and falls through to the ordinary "not enough" tail, so the caller
 * sees SLOT_SHORTAGE with a real placeable count — or, with `allowPartial`,
 * the sessions that did fit.
 */
/**
 * The scheduling-zone calendar days either side of `start`'s day, as day
 * keys. Calendar arithmetic on the key, so a daylight-saving change (a 23 or
 * 25 hour day) never skips or repeats a neighbour.
 */
export function adjacentDayKeys(start: Date, timeZone?: string): string[] {
  const dayMs = Date.parse(
    `${ScheduleCalculationService.dayKey(start, timeZone)}T00:00:00Z`,
  );
  return [dayMs - DAY_MS, dayMs + DAY_MS].map((ms) =>
    new Date(ms).toISOString().slice(0, 10),
  );
}

export async function findAvailableSlots(
  // #908 — accepts the base client so slot discovery can run OUTSIDE the write
  // transaction (under the locks). Reads only — no writes happen here.
  db: PrismaLike,
  consultant: ConsultantAllocationData,
  totalSlotsNeeded: number,
  slotsPerCall: number,
  eventType: EventType,
  config: EventConfig,
  excludeAppointmentIds: string[] = [],
  eventOwnAppointments: AppointmentWithSlots[] = [],
  // #898 follow-up — when set, the CONSULTEE's existing bookings (across ANY
  // consultant) are also treated as occupied, so auto-allocate picks
  // mutually-free slots instead of consultant-free ones that then fail the
  // consultee-conflict validation.
  consulteeUserId?: string,
  // Lets the occupancy predicate include appointments delivered under this
  // consultant's own plans, matching what the availability grid counts.
  consultantProfileId?: string,
  // #1065 — how the consultee would like the replacement placed. Scores
  // candidates; absent (or all-null) leaves selection exactly as it was.
  preference?: AllocationPreference,
  // #1194 — identifies the walk in the truncation warning below.
  eventId?: string,
  // #1206 — return what fits instead of throwing SLOT_SHORTAGE. Only the
  // consultant, having been shown the shortfall, can turn this on.
  allowPartial = false,
  // #1554 — the tentative occurrences a reschedule replaces: left out of
  // bookedSlots and of the weekly/daily seeds while their wrapper stays.
  excludeOccurrenceIds: string[] = [],
  // 30-minute interval starts (ISO) another writer holds right now; a re-search
  // after a refused slot batch treats them as booked.
  heldSlotStarts: readonly string[] = [],
  // A caller that searches more than once passes one budget for all of them;
  // otherwise this search opens its own once the reads are done.
  sharedBudget?: SearchBudget,
  // No candidate starts sooner than this from now (`leadMsFor`).
  leadTimeMs: number = MINIMUM_BOOKING_LEAD_TIME_MS,
): Promise<Date[]> {
  const walk: AllocationWalkContext = {
    eventType,
    eventId,
    consultantProfileId,
    reportedTruncations: new Set(),
  };
  if (consultant.scheduleType === ScheduleType.WEEKLY) {
    reportIncompleteWeeklyRows(
      partitionWeeklyRows(consultant.availabilityWindowsWeekly).refused,
      { op: "auto-allocate", consultantProfileId },
    );
  }
  // Only FUTURE occupancy can collide with a candidate: buildConsecutiveBlock
  // rejects any candidate start before `now`, so a slot that has already
  // ended can never block a placement. Bounding the read to live intervals
  // keeps this query O(upcoming bookings) instead of O(entire consultant
  // history) — the pool-starvation shape documented in
  // docs/performance/05-allocation-500-investigation.md.
  const occupancyClock = new Date();

  // Get all existing booked slots for this consultant
  // FIX Bug #15: Use centralized occupancy policy for consistent conflict detection
  // Shared with the availability grid so the two cannot disagree about who
  // is busy — see buildConsultantOccupancyWhere.
  const appointmentFilter: Prisma.AppointmentWhereInput[] = [
    buildConsultantOccupancyWhere(
      consultantProfileId,
      consultant.userId,
      occupancyClock,
    ),
    // Bounded read — see occupancyClock above.
    {
      occurrences: {
        some: {
          endsAt: { gt: occupancyClock },
          ...OCCUPYING_OCCURRENCE_WHERE,
        },
      },
    },
  ];

  // Exclude tentative appointments during reschedule — they'll be deleted,
  // so their slots should not block availability or count toward weekly limits.
  if (excludeAppointmentIds.length > 0) {
    appointmentFilter.push({
      NOT: { id: { in: excludeAppointmentIds } },
    });
  }

  const existingAppointments = await db.appointment.findMany({
    where: {
      AND: appointmentFilter,
    },
    include: {
      // Tombstoned children of a qualifying appointment must not enter
      // bookedSlots — the parent-level filter above only qualifies the
      // appointment, not every row this include returns.
      // endsAt bound keeps bookedSlots O(upcoming): past children can never
      // match a candidate (buildConsecutiveBlock rejects < now), so
      // materializing them only re-creates pool pressure on long-lived
      // appointments (CodeRabbit triage).
      occurrences: {
        where: {
          ...OCCUPYING_OCCURRENCE_WHERE,
          endsAt: { gt: occupancyClock },
          ...(excludeOccurrenceIds.length > 0
            ? { id: { notIn: excludeOccurrenceIds } }
            : {}),
        },
      },
      // RV-2 — status + payment let isOccupiedByLiveAppointment drop expired
      // APPROVED_PENDING_PAYMENT holds, matching what the validator skips.
      consultation: { select: { status: true, bookingSource: true } },
      subscription: { select: { status: true, bookingSource: true } },
      payment: { select: { expiresAt: true, paymentStatus: true } },
    },
  });

  // RV-2 — an expired pending-payment hold is not a live blocker, so its slots
  // must not enter bookedSlots; otherwise the allocator avoids a slot the
  // validator would happily accept and the two disagree.
  // #1554 — a row is a whole call, so every 30-minute interval it covers is
  // booked, not just its start; a 09:30 candidate must see a 09:00–10:00
  // call, or selection proposes what the validator then rejects.
  const bookedSlots = new Set(
    existingAppointments
      .filter((appointment) =>
        isOccupiedByLiveAppointment(appointment, occupancyClock),
      )
      .flatMap((appointment) =>
        appointment.occurrences.flatMap((slot) =>
          intervalStartsOf(slot).map((start) => start.toISOString()),
        ),
      ),
  );

  // #898 follow-up — also fold the CONSULTEE's existing bookings into
  // bookedSlots so auto-allocate avoids slots where the consultee is already
  // busy with ANOTHER consultant. Without this, selection picks
  // consultant-free slots that then fail validateNoConflicts' consultee check
  // (a graceful 400, but no placement and no retry). Mirrors the consultant
  // query above, scoped to the consultee's seats (#1554) — bounded to
  // live intervals for the same reason.
  if (consulteeUserId) {
    const consulteeAppointments = await db.appointment.findMany({
      where: {
        AND: [
          { OR: buildOccupiedAppointmentFilter() },
          {
            participants: {
              some: timeHoldingParticipant(occupancyClock, consulteeUserId),
            },
          },
          {
            occurrences: {
              some: {
                endsAt: { gt: occupancyClock },
                ...OCCUPYING_OCCURRENCE_WHERE,
                ...(excludeOccurrenceIds.length > 0
                  ? { id: { notIn: excludeOccurrenceIds } }
                  : {}),
              },
            },
          },
          ...(excludeAppointmentIds.length > 0
            ? [{ NOT: { id: { in: excludeAppointmentIds } } }]
            : []),
        ],
      },
      include: {
        // Same tombstone exclusion as the consultant query above.
        // endsAt bound keeps bookedSlots O(upcoming): past children can never
        // match a candidate (buildConsecutiveBlock rejects < now), so
        // materializing them only re-creates pool pressure on long-lived
        // appointments (CodeRabbit triage).
        occurrences: {
          where: {
            ...OCCUPYING_OCCURRENCE_WHERE,
            endsAt: { gt: occupancyClock },
            ...(excludeOccurrenceIds.length > 0
              ? { id: { notIn: excludeOccurrenceIds } }
              : {}),
          },
        },
        consultation: { select: { status: true, bookingSource: true } },
        subscription: { select: { status: true, bookingSource: true } },
        payment: { select: { expiresAt: true, paymentStatus: true } },
      },
    });
    consulteeAppointments
      .filter((appointment) =>
        isOccupiedByLiveAppointment(appointment, occupancyClock),
      )
      .flatMap((appointment) =>
        appointment.occurrences.flatMap((slot) =>
          intervalStartsOf(slot).map((start) => start.toISOString()),
        ),
      )
      .forEach((iso) => bookedSlots.add(iso));
  }
  for (const iso of heldSlotStarts) bookedSlots.add(iso);

  // Validate availability exists
  const projectableWeekly = projectableWeeklyRows(consultant);
  const hasWeeklySlots = projectableWeekly.length > 0;
  const hasCustomSlots =
    consultant.hasCustomRows ?? consultant.availabilityWindowsCustom.length > 0;
  if (
    (consultant.scheduleType === ScheduleType.WEEKLY && !hasWeeklySlots) ||
    (consultant.scheduleType === ScheduleType.CUSTOM && !hasCustomSlots)
  ) {
    throw new AllocationValidationError(
      "No availability slots configured for consultant",
      "NO_AVAILABILITY",
    );
  }

  // The earliest a placed session may start: occupancy is read from the real
  // clock above, candidates start no sooner than the lead time after it.
  const now = new Date(occupancyClock.getTime() + leadTimeMs);
  const selectedSlots: Date[] = [];
  // Opened once the reads are done, so the ceiling bounds the SEARCH (the only
  // O(window) work in this request) and not the queries that feed it. A
  // truncated search answers through the same shortage tail below, so
  // `allowPartial` keeps working exactly as it does for a full calendar.
  const searchBudget =
    sharedBudget ?? createSearchBudget(ALLOCATOR_SEARCH_TIME_BUDGET_MS);

  // Sort weekly slots by next calendar occurrence (not raw clock time)
  // so auto-allocation picks the chronologically earliest slot first.
  // Without this, Tue 08:00 (480min) would sort before Mon 09:00 (540min).
  const sortedWeekly =
    consultant.scheduleType === ScheduleType.WEEKLY
      ? sortWeeklyByNextOccurrence(projectableWeekly, now)
      : [];

  // #1065 — the preference's ceiling. Zero when nothing was asked for, which
  // makes every "is this candidate perfect?" test below true on the first
  // placeable candidate and preserves first-fit verbatim.
  const maxScore = maxPreferenceScore(preference);

  // For consultations/webinars: find one consecutive block, searching multiple weeks
  if (eventType === "consultation" || eventType === "webinar") {
    const singleSession = bestBlockForSingleSession(
      eventType,
      consultant,
      slotsPerCall,
      bookedSlots,
      now,
      sortedWeekly,
      consultant.availabilityWindowsCustom,
      config.schedulingTimezone,
      preference,
      walk,
      searchBudget,
    );
    if (singleSession) return singleSession;
    // A walk the budget cut short never saw the whole calendar: not a shortage.
    if (searchBudget.exhausted()) throw searchTimeout(searchBudget, walk);

    // One session, so nothing is placeable short of the whole thing —
    // placeableSessions 0 tells the client not to offer a partial schedule.
    throw new SlotShortageError(
      `No free time in the coming weeks fits this ${eventType}. Open up more availability or pick a time yourself.`,
      0,
      1,
    );
  }

  // For subscriptions/classes: find distributed slots across weeks
  const startDate = config.schedulingPeriodStartsAt || new Date();
  const endDate =
    config.schedulingPeriodEndsAt ||
    addMonths(startDate, config.durationInMonths || 1);
  const sessionsPerWeek = config.sessionsPerWeek || 1;

  // Build a map of existing confirmed calls per week.
  // During partial reschedule, weeks with confirmed appointments already
  // have calls that must count toward the weekly limit.
  // IMPORTANT: Only count THIS event's own appointments (not consultations or
  // other event types), and exclude the tentative ones being replaced.
  const excludeSet = new Set(excludeAppointmentIds);
  const excludedOccurrences = new Set(excludeOccurrenceIds);
  const existingSessionsPerWeek = new Map<string, number>();
  // Sessions per day already spoken for by surviving calls — the seed of
  // the per-day cap counter. Seeded for the same reason as the week map:
  // validatePerDaySessionCap counts existing calls, so a partial reschedule
  // that only looked at this run's placements could put a replacement on a
  // day that is already at its cap and be rejected downstream.
  // #1554 — one live occurrence = one session.
  const existingSessionsPerDay = new Map<string, number>();
  const survivingOccurrences = eventOwnAppointments
    .filter((apt) => !excludeSet.has(apt.id))
    .flatMap((apt) => apt.occurrences)
    .filter(
      (s) =>
        !excludedOccurrences.has(s.id) &&
        !s.isTentative &&
        !isDeadOccurrence(s),
    );
  for (const firstSlot of survivingOccurrences) {
    // ADR B9 — weekly buckets in the event's scheduling timezone
    const weekKey = ScheduleCalculationService.weekKey(
      new Date(firstSlot.startsAt),
      config.schedulingTimezone,
    );
    existingSessionsPerWeek.set(
      weekKey,
      (existingSessionsPerWeek.get(weekKey) || 0) + 1,
    );
    const dayKey = ScheduleCalculationService.dayKey(
      new Date(firstSlot.startsAt),
      config.schedulingTimezone,
    );
    existingSessionsPerDay.set(
      dayKey,
      (existingSessionsPerDay.get(dayKey) || 0) + 1,
    );
  }

  // The cursor advances in UTC days and each weekly occurrence is filed under
  // the UTC day its start falls on, so every occurrence is offered exactly once.
  //
  // Caps are counted in the event's scheduling timezone (ADR B9), keyed off
  // the placed slot rather than the cursor, so the two bucketings cannot drift.
  const sessionsPlacedPerWeek = new Map(existingSessionsPerWeek);
  // Per-day cap counter, seeded from the surviving sessions. The cap is the
  // SAME constant validatePerDaySessionCap enforces (sessionCaps.ts) — it
  // used to be a hard one-session-per-day set, which made auto-allocate
  // unable to fill a class whose sessionsPerWeek exceeds its available
  // days per week even though the validator (and manual allocation) allow
  // two sessions on one day.
  const placedPerDay = new Map(existingSessionsPerDay);
  const maxPerDay =
    eventType === "class"
      ? MAX_CLASS_SESSIONS_PER_DAY
      : MAX_SUBSCRIPTION_SESSIONS_PER_DAY;

  // Availability over the whole period, projected once and filed by the UTC day
  // each span starts on: weekly occurrences in `sortedWeekly` order, custom rows
  // as one slice per scheduling-zone day in start order.
  const periodStart = new Date(
    Date.UTC(
      startDate.getUTCFullYear(),
      startDate.getUTCMonth(),
      startDate.getUTCDate(),
    ),
  );
  const rowSpansByUtcDay = new Map<number, RowSpan[]>();
  const fileSpan = (dayMs: number, span: RowSpan) => {
    const spans = rowSpansByUtcDay.get(dayMs) ?? [];
    spans.push(span);
    rowSpansByUtcDay.set(dayMs, spans);
  };
  if (consultant.scheduleType === ScheduleType.WEEKLY) {
    const periodEnd = new Date(endDate.getTime() + DAY_MS);
    for (const slot of sortedWeekly) {
      for (const occurrence of weeklyRowIntervalsInRange(
        slot,
        periodStart,
        periodEnd,
      )) {
        fileSpan(Math.floor(occurrence.start.getTime() / DAY_MS) * DAY_MS, {
          start: occurrence.start,
          endMs: occurrence.end.getTime(),
        });
      }
    }
  } else {
    // A custom row is an absolute range that may span days: clipped to the
    // period, it is walked as one slice per scheduling-zone day, so every day
    // it covers is a candidate, including the tail of a row begun earlier.
    for (const span of customSpansInStartOrder(
      consultant.availabilityWindowsCustom,
      config.schedulingTimezone,
      { startMs: startDate.getTime(), endMs: endDate.getTime() },
    )) {
      fileSpan(Math.floor(span.start.getTime() / DAY_MS) * DAY_MS, span);
    }
  }

  /**
   * Availability spans that start on this UTC day. The end lets
   * candidateStartsInRow bound its walk to the span's own time range.
   */
  const rowStartsForDay = (currentDay: Date): RowSpan[] =>
    rowSpansByUtcDay.get(currentDay.getTime()) ?? [];

  /**
   * Whether the per-day cap, and for a class the calendar-week cap, still
   * have room for a call starting here. A subscription's weekly limit is its
   * rolling cycle, already applied as the window and `totalSlotsNeeded`.
   */
  const hasRoomOn = (candidateStart: Date): boolean =>
    (placedPerDay.get(
      ScheduleCalculationService.dayKey(
        candidateStart,
        config.schedulingTimezone,
      ),
    ) ?? 0) < maxPerDay &&
    (eventType !== "class" ||
      (sessionsPlacedPerWeek.get(
        ScheduleCalculationService.weekKey(
          candidateStart,
          config.schedulingTimezone,
        ),
      ) ?? 0) < sessionsPerWeek);

  /**
   * Place at most `maxPerDay` calls on this day, honouring the
   * timezone-bucketed per-day and per-week caps the validator will
   * re-check.
   *
   * `perfectOnly` is the day-preference half of #1065. A day of the week is a
   * property of the whole day, so unlike the time band it cannot be chosen
   * between candidates inside one row — the sweep has to be run twice
   * instead. The first pass accepts only fully-preferred placements; the
   * second accepts anything and is byte-for-byte the sweep that shipped
   * before. Passing over a day in the first sweep never loses it, because the
   * second sweep walks the same window with the same cap counters.
   */
  /**
   * Sessions spread across the week: no session the day before or after
   * another one (placed now or already held).
   */
  const isSpacedFrom = (candidateStart: Date): boolean =>
    adjacentDayKeys(candidateStart, config.schedulingTimezone).every(
      (key) => !placedPerDay.has(key),
    );

  /** The candidate's own day holds no session yet (a class may otherwise stack two). */
  const dayIsEmpty = (candidateStart: Date): boolean =>
    !placedPerDay.has(
      ScheduleCalculationService.dayKey(
        candidateStart,
        config.schedulingTimezone,
      ),
    );

  const tryPlaceOnDay = (
    currentDay: Date,
    perfectOnly: boolean,
    spacing: Spacing,
  ): boolean => {
    const roomy =
      spacing === "spaced"
        ? (start: Date) =>
            hasRoomOn(start) && dayIsEmpty(start) && isSpacedFrom(start)
        : spacing === "onePerDay"
          ? (start: Date) => hasRoomOn(start) && dayIsEmpty(start)
          : hasRoomOn;
    let best: { block: Date[]; score: number } | null = null;

    for (const { start: rowStart, endMs: rowEndMs } of rowStartsForDay(
      currentDay,
    )) {
      // A row inside one scheduling-timezone day shares that day's caps and
      // weekday, so it can be ruled out before its walk; an overnight row's
      // tail lands on the next day and is judged per candidate instead.
      const lastRowAtom = new Date(rowEndMs - SCHEDULING_INTERVAL_MS);
      const withinOneDay =
        ScheduleCalculationService.dayKey(
          rowStart,
          config.schedulingTimezone,
        ) ===
        ScheduleCalculationService.dayKey(
          lastRowAtom,
          config.schedulingTimezone,
        );
      if (withinOneDay && !hasRoomOn(rowStart)) continue;
      if (
        withinOneDay &&
        perfectOnly &&
        !matchesPreferredDays(rowStart, preference, config.schedulingTimezone)
      ) {
        continue;
      }

      const candidate = bestFittingBlockInRow(
        rowStart,
        slotsPerCall,
        consultant,
        bookedSlots,
        {
          now,
          startDate,
          endDate,
          schedulingTimezone: config.schedulingTimezone,
          hasRoomOn: perfectOnly
            ? (start) =>
                roomy(start) &&
                matchesPreferredDays(
                  start,
                  preference,
                  config.schedulingTimezone,
                )
            : roomy,
        },
        rowEndMs,
        preference,
        walk,
      );
      if (!candidate) continue;
      // LOAD-BEARING: discarding a placeable block here is only safe because
      // sweepPeriod(false) below is UNCONDITIONAL. Any early return inserted
      // between the two sweeps turns this line into a filter and
      // reintroduces #1065 — the preference would start costing allocations.
      if (perfectOnly && candidate.score < maxScore) continue;

      // A full match ends the row walk for the same reason it ends the
      // candidate walk — and with no preference maxScore is 0, so the first
      // row that yields anything wins, exactly as before.
      if (candidate.score >= maxScore) {
        best = candidate;
        break;
      }
      if (!best || candidate.score > best.score) best = candidate;
    }

    if (!best) return false;

    const sessionSlots = best.block;
    selectedSlots.push(...sessionSlots);
    sessionSlots.forEach((s) => bookedSlots.add(s.toISOString()));

    // Re-key on the slot actually placed rather than on the row it came
    // from, so the counters record where the session really landed.
    const placedDayKey = ScheduleCalculationService.dayKey(
      sessionSlots[0],
      config.schedulingTimezone,
    );
    const placedWeekKey = ScheduleCalculationService.weekKey(
      sessionSlots[0],
      config.schedulingTimezone,
    );
    placedPerDay.set(placedDayKey, (placedPerDay.get(placedDayKey) ?? 0) + 1);
    sessionsPlacedPerWeek.set(
      placedWeekKey,
      (sessionsPlacedPerWeek.get(placedWeekKey) ?? 0) + 1,
    );

    return true;
  };

  /**
   * One walk of the scheduling period, day by day, until the need is met.
   *
   * Each day hosts as many sessions as its per-day cap (sessionCaps.ts)
   * allows, not just one: a class whose sessionsPerWeek exceeds the
   * consultant's available days per week can only be satisfied by stacking
   * sessions on a day, which is exactly what validatePerDaySessionCap
   * permits (≤2/day) and what the old one-placement-per-day cursor
   * made impossible. The while loop terminates because every successful
   * placement strictly advances a bounded counter (per-day cap, weekly cap,
   * totalSlotsNeeded).
   *
   * The budget stops the DAY walk, which is the coarsest unit that still
   * bounds the overrun: one day is one pass over that day's rows. A walk it
   * truncates before every session is placed answers SEARCH_TIMEOUT below.
   */
  const sweepPeriod = (
    perfectOnly: boolean,
    spacing: Spacing = "packed",
  ): void => {
    const cursor = new Date(
      Date.UTC(
        startDate.getUTCFullYear(),
        startDate.getUTCMonth(),
        startDate.getUTCDate(),
      ),
    );

    for (
      ;
      cursor <= endDate && selectedSlots.length < totalSlotsNeeded;
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      if (searchBudget.exhausted()) {
        reportSearchBudgetSpent(searchBudget, consultant, walk);
        return;
      }
      while (
        selectedSlots.length < totalSlotsNeeded &&
        tryPlaceOnDay(new Date(cursor), perfectOnly, spacing)
      ) {
        // Placed; re-attempt the same day under the updated counters.
      }
    }
  };

  // Skipped entirely when nothing was asked for, so the single sweep below is
  // the only one that runs and today's placements are reproduced exactly.
  const recurring = eventType === "subscription" || eventType === "class";
  if (maxScore > 0) {
    if (recurring) sweepPeriod(true, "spaced");
    sweepPeriod(true);
  }
  // A recurring plan first keeps a free day between sessions, so a week of 3
  // lands Mon/Wed/Fri rather than Mon/Tue/Wed; a class then tries one a day
  // before stacking two. Like the preference pass, neither costs a placement,
  // because the packed sweep below reconsiders everything they declined.
  if (recurring) sweepPeriod(false, "spaced");
  if (eventType === "class") sweepPeriod(false, "onePerDay");
  // MUST stay unconditional and MUST stay over the whole window. This is the
  // only thing making the preferred-only sweep above a preference rather than
  // a filter: everything it declined is reconsidered here.
  sweepPeriod(false);

  if (selectedSlots.length < totalSlotsNeeded) {
    // A truncated sweep never saw the whole window, so neither a shortage nor a
    // partial plan is the truth: the consultant retries or picks by hand.
    if (searchBudget.exhausted()) throw searchTimeout(searchBudget, walk);
    // PR 2c resilience (audit gap #6) — a consultant staring at "Could only
    // find 0 of 12" deserves to know WHY: the scheduling period is over
    // (add availability or extend the period), vs everything is booked
    // (wait for cancellations), vs caps are unsatisfiable. The period check
    // runs first because it's the most actionable answer.
    if (config.schedulingPeriodEndsAt && config.schedulingPeriodEndsAt < now) {
      throw new AllocationValidationError(
        "This plan's scheduling period has ended, so no more sessions can be placed. Sessions that were never held are refunded when the plan settles.",
        "PERIOD_ENDED",
        {
          schedulingPeriodEndsAt: config.schedulingPeriodEndsAt.toISOString(),
          placedAtoms: selectedSlots.length,
          requiredAtoms: totalSlotsNeeded,
        },
      );
    }
    // #1206 — whole SESSIONS, which is the unit the consultant reasons in
    // and the only unit a partial schedule can be measured in. The sweep
    // only ever places complete sessions, so this division is exact.
    const placeableSessions = Math.floor(selectedSlots.length / slotsPerCall);
    const requiredSessions = Math.ceil(totalSlotsNeeded / slotsPerCall);

    // The consultant said "place what fits and follow up with the rest".
    // A paid subscription whose window cannot hold every session used to be
    // simply unallocatable — nothing was scheduled at all.
    if (allowPartial && placeableSessions > 0) {
      return selectedSlots
        .slice(0, placeableSessions * slotsPerCall)
        .sort((a, b) => a.getTime() - b.getTime());
    }

    throw new SlotShortageError(
      `Only ${placeableSessions} of ${requiredSessions} sessions fit in the free times. Open up more availability, or schedule the ones that fit now.`,
      placeableSessions,
      requiredSessions,
    );
  }

  return selectedSlots.sort((a, b) => a.getTime() - b.getTime());
}

/** The typed answer for a walk the time budget truncated before it finished. */
function searchTimeout(
  budget: SearchBudget,
  walk: AllocationWalkContext | undefined,
): SearchTimeoutError {
  return new SearchTimeoutError({
    budgetMs: budget.limitMs,
    spentMs: budget.spentMs(),
    eventType: walk?.eventType ?? null,
    eventId: walk?.eventId ?? null,
  });
}
