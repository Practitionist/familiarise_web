import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { reportSentryError } from "@/lib/observability/report";
import {
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  type Day,
} from "date-fns";
import {
  AllocationService,
  type GridLead,
} from "@/lib/scheduling/allocationService";
import {
  availabilityPollJitterMs,
  createAvailabilityPoller,
  RATE_LIMIT_FALLBACK_BACKOFF_MS,
  type PollFetchOutcome,
} from "@/lib/scheduling/availabilityPolling";
import { ApiResponseError } from "@/lib/fetch-helpers";
import {
  availabilityFreshness,
  sameFreshness,
  FRESHNESS_TICK_MS,
  type AvailabilityFreshnessState,
} from "@/lib/labels/availability-freshness";
import type { GridQuota } from "@/lib/scheduling/grid-quota";
import type {
  OverlapDetail,
  ServerCell,
} from "@/lib/scheduling/week-grid-model";
import { dayRangeBounds } from "@/lib/time/grid-zone";
import { gridTimeZone } from "@/lib/scheduling/time-picker-focus";
import type { BookableInterval } from "@/utils/scheduling-engine/types";
import { isReleasedForReschedule } from "@/utils/scheduling-engine/types";
import { byCodeUnit } from "@/lib/scheduling/code-unit-order";

/**
 * The dashboard grid's data: consultant details, the server-resolved
 * availability window (one cell per 30-minute atom), and this booking's own
 * sessions. The server is the only source of a cell's status; the client adds
 * only what depends on the clock (past) in the component.
 */

export interface UseCalendarDataOptions {
  consultantId: string;
  eventType?: "consultation" | "subscription" | "webinar" | "class";
  eventId?: string;
  autoLoad?: boolean;
  view: "week" | "month";
  currentDate: Date;
  mode: "view" | "select" | "allocate";
  /** The scheduling period bounds what is SELECTABLE (the calendar's range
   * guard); the fetch window always follows the visible week or month. */
  allowedStart?: Date;
  allowedEnd?: Date;
  /** The user whose calendar is being booked; their other bookings read busy. */
  consulteeUserId?: string;
  /** The zone the grid is drawn in; cells, the fetch window and `timezone` follow it. */
  gridZone?: string;
  /** The day the week grid starts on; the fetch window follows it. */
  weekStartsOn?: Day;
  /** Per-cell overlap detail; the route refuses it to anyone but the owner. */
  includeAppointmentDetails?: boolean;
  /** Occurrences a reschedule would release; the plan-limit overlay counts them free. */
  releasingOccurrenceIds?: readonly string[];
  /** The writer the grid is drawn for; its lead time decides "too soon". */
  lead?: GridLead;
}

export type { BookableInterval, OverlapDetail, ServerCell };

interface EventPlanInfo {
  title?: string;
}

interface AppointmentConsultation {
  status?: string;
  consultationPlan?: EventPlanInfo;
  requestedBy?: { user?: { name?: string } };
}

interface AppointmentSubscription {
  id?: string;
  status?: string;
  subscriptionPlan?: EventPlanInfo & {
    sessionsPerWeek?: number;
    durationInMonths?: number;
    totalSessions?: number;
  };
  requestedBy?: { user?: { name?: string } };
  /** The entitlement frozen at purchase (null on older rows). */
  sessionsTotal?: number | null;
  /** The weekly cap frozen at purchase; null reads the plan. */
  sessionsPerWeek?: number | null;
  /** Sessions a support partial refund removed from the plan. */
  sessionsRefunded?: number;
  schedulingPeriodStartsAt?: string;
  schedulingTimezone?: string;
  /** The fixed, exclusive plan end (incident extensions move it). */
  planEndsAt?: string | null;
}

/** What the cycle heading needs from the subscription row. */
export interface SubscriptionMeta {
  sessionsTotal: number;
  sessionsRefunded: number;
  sessionsPerWeek: number;
  durationInMonths: number;
  schedulingPeriodStartsAt: string;
  schedulingTimezone: string;
  /** Null on rows written before the fixed plan end existed. */
  planEndsAt: string | null;
}

/** One live-or-dead row of the event's wrapper, as the entitlement helper reads it. */
export interface EventOccurrence {
  /** Absent when the payload carries no occurrence id. */
  id?: string;
  startsAt: string;
  endsAt: string;
  completionStatus: string | null;
  isTentative: boolean;
  deletedAt: string | null;
}

interface AppointmentWebinar {
  status?: string;
  webinarPlan?: EventPlanInfo;
}

interface AppointmentClass {
  status?: string;
  classPlan?: EventPlanInfo;
}

interface AppointmentSlotRaw {
  id?: string;
  startsAt: string;
  endsAt: string;
  isTentative?: boolean;
  completionStatus?: string | null;
  deletedAt?: string | null;
  user?: Array<{ name?: string }>;
}

interface Appointment {
  id: string;
  appointmentType: string;
  occurrences?: AppointmentSlotRaw[];
  consultation?: AppointmentConsultation;
  subscription?: AppointmentSubscription;
  webinar?: AppointmentWebinar;
  class?: AppointmentClass;
}

/** The entitlement inputs, or null when the payload predates them. */
function subscriptionMetaOf(
  subscription: AppointmentSubscription | undefined,
): SubscriptionMeta | null {
  const plan = subscription?.subscriptionPlan;
  if (
    !subscription?.schedulingPeriodStartsAt ||
    !subscription.schedulingTimezone ||
    plan?.sessionsPerWeek === undefined ||
    plan.durationInMonths === undefined ||
    plan.totalSessions === undefined ||
    subscription.sessionsRefunded === undefined
  ) {
    return null;
  }
  return {
    sessionsTotal: subscription.sessionsTotal ?? plan.totalSessions,
    sessionsRefunded: subscription.sessionsRefunded,
    sessionsPerWeek: subscription.sessionsPerWeek ?? plan.sessionsPerWeek,
    durationInMonths: plan.durationInMonths,
    schedulingPeriodStartsAt: subscription.schedulingPeriodStartsAt,
    schedulingTimezone: subscription.schedulingTimezone,
    planEndsAt: subscription.planEndsAt ?? null,
  };
}

interface ConsultantData {
  id: string;
  name: string;
  timezone?: string | null;
}

/** One server cell as the grid answers it. */
export interface RawSlotData {
  slotId: string;
  startsAt: string;
  endsAt: string;
  bookingStatus: "available" | "partially-booked" | "fully-booked";
  type: "WEEKLY" | "CUSTOM";
  tooSoon?: boolean;
  limitReached?: boolean;
  overlappingAppointments?: OverlapDetail[];
  outsideCoHostHours?: boolean;
  outsideCoHostHoursOf?: string[];
  beyondHorizon?: boolean;
}

const NO_OVERLAPS: OverlapDetail[] = [];
const ATOM = 30 * 60 * 1000;

/** Plain copy only; the raw cause goes to the console and Sentry, never the screen. */
export const CALENDAR_LOAD_ERROR =
  "We couldn't load this calendar. Check your connection and try again.";

interface CalendarData {
  consultantDetails: ConsultantData | null;
  /** Server cells by start ms; identity changes only when the data does. */
  serverCells: ReadonlyMap<number, ServerCell>;
  availableSlots: BookableInterval[];
  eventSlots: BookableInterval[];
  /** This event's own sessions released for a reschedule ("Being moved"). */
  eventTentativeSlots: BookableInterval[];
  eventOccurrences: EventOccurrence[];
  subscriptionMeta: SubscriptionMeta | null;
  /** The plan's weekly/day limit for the subscription being booked, if any. */
  quota: GridQuota | null;
  /** The half-open window `serverCells` answers for; null before the first answer. */
  cellsWindow: { startMs: number; endMs: number } | null;
  /** First load only: until consultant details and the first window settle. */
  loading: boolean;
  /** A navigation or explicit refetch is in flight; the grid stays mounted. */
  refreshing: boolean;
  error: string | null;
  /** A refresh failed after a good load; the last cells stay on screen. */
  refreshFailed: boolean;
  /** The booking's own sessions failed to load; caps and own-time paint may be wrong. */
  eventSlotsFailed: boolean;
}

export interface UseCalendarDataReturn extends CalendarData {
  /** The lead time the server applied to these cells; re-applied between polls. */
  leadMs: number | null;
  refetch: () => Promise<void>;
  refetchAvailability: () => Promise<void>;
  refetchEventSlots: () => Promise<void>;
  /** Age of the cells on screen. Informational only. */
  availabilityFreshness: AvailabilityFreshnessState;
}

function isValidRawSlot(slot: RawSlotData | null | undefined): boolean {
  return Boolean(slot?.startsAt && slot.endsAt);
}

export function useCalendarData(
  options: UseCalendarDataOptions,
): UseCalendarDataReturn {
  const {
    consultantId,
    eventType,
    eventId,
    autoLoad = true,
    view,
    currentDate,
    consulteeUserId,
    includeAppointmentDetails = false,
    weekStartsOn = 0,
    releasingOccurrenceIds,
    lead,
  } = options;
  const leadPurpose = lead?.purpose;
  const leadUnpaid = lead?.unpaid === true;
  const releasing = releasingOccurrenceIds?.length
    ? [...releasingOccurrenceIds].sort(byCodeUnit).join(",")
    : undefined;
  const gridZone = options.gridZone ?? gridTimeZone();

  const [consultantDetails, setConsultantDetails] =
    useState<ConsultantData | null>(null);
  const [rawSlots, setRawSlots] = useState<RawSlotData[]>([]);
  const [quota, setQuota] = useState<GridQuota | null>(null);
  const [leadMs, setLeadMs] = useState<number | null>(null);
  const [cellsWindow, setCellsWindow] = useState<{
    startMs: number;
    endMs: number;
  } | null>(null);
  const [eventSlots, setEventSlots] = useState<BookableInterval[]>([]);
  const [eventTentativeSlots, setEventTentativeSlots] = useState<
    BookableInterval[]
  >([]);
  const [eventOccurrences, setEventOccurrences] = useState<EventOccurrence[]>(
    [],
  );
  const [subscriptionMeta, setSubscriptionMeta] =
    useState<SubscriptionMeta | null>(null);
  const [eventSlotsFailed, setEventSlotsFailed] = useState(false);
  const [settled, setSettled] = useState({
    consultant: !autoLoad,
    availability: !autoLoad,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [consultantError, setConsultantError] = useState<string | null>(null);
  const [availabilityError, setAvailabilityError] = useState<string | null>(
    null,
  );

  // Only the response to the most recently issued request may commit state.
  const availabilityRequestIdRef = useRef(0);
  // When the last availability fetch SETTLED (success or failure): the poll's clock.
  const availabilityFetchedAtRef = useRef(Number.NaN);
  // When the last availability fetch SUCCEEDED: what the freshness label measures.
  const lastSuccessAtRef = useRef(Number.NaN);
  const availabilityFailedPollsRef = useRef(0);
  const [availabilityFreshnessState, setAvailabilityFreshnessState] =
    useState<AvailabilityFreshnessState>({
      freshness: "unknown",
      label: null,
      failed: false,
    });
  // Re-read the clock on a timer so the age keeps moving; an equal state is
  // dropped so an idle grid does not re-render every tick.
  useEffect(() => {
    if (!autoLoad || !consultantId) return;
    const tick = () => {
      const next = availabilityFreshness(
        lastSuccessAtRef.current,
        Date.now(),
        availabilityFailedPollsRef.current,
      );
      setAvailabilityFreshnessState((previous) =>
        sameFreshness(previous, next) ? previous : next,
      );
    };
    tick();
    const id = setInterval(tick, FRESHNESS_TICK_MS);
    return () => clearInterval(id);
  }, [autoLoad, consultantId, rawSlots, availabilityError]);

  // A poll waits on an in-flight navigation fetch instead of racing it.
  const availabilityInFlightRef = useRef<Promise<void> | null>(null);
  // The last ETag, echoed as If-None-Match; the tag encodes window and viewer.
  const availabilityEtagRef = useRef<string | null>(null);
  // A re-issue or unmount aborts the in-flight event-slots read.
  const eventSlotsAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => eventSlotsAbortRef.current?.abort(), []);
  // Read by the poll, so a failed event-slots read retries with it.
  const eventSlotsFailedRef = useRef(false);
  useEffect(() => {
    eventSlotsFailedRef.current = eventSlotsFailed;
  }, [eventSlotsFailed]);

  const serverCells = useMemo(() => {
    const map = new Map<number, ServerCell>();
    for (const slot of rawSlots) {
      const startMs = new Date(slot.startsAt).getTime();
      const endMs = new Date(slot.endsAt).getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
      map.set(startMs, {
        startMs,
        endMs,
        bookingStatus: slot.bookingStatus,
        tooSoon: slot.tooSoon === true,
        limitReached: slot.limitReached === true,
        overlappingAppointments: slot.overlappingAppointments ?? NO_OVERLAPS,
        outsideCoHostHours: slot.outsideCoHostHours === true,
        outsideCoHostHoursOf: slot.outsideCoHostHoursOf,
        beyondHorizon: slot.beyondHorizon === true,
      });
    }
    return map;
  }, [rawSlots]);

  const availableSlots = useMemo(
    (): BookableInterval[] =>
      rawSlots.map((slot) => ({
        startTime: new Date(slot.startsAt),
        endTime: new Date(slot.endsAt),
        isAvailable:
          slot.bookingStatus === "available" ||
          slot.bookingStatus === "partially-booked",
        isBooked: slot.bookingStatus === "fully-booked",
      })),
    [rawSlots],
  );

  const fetchConsultantDetails = useCallback(async (): Promise<void> => {
    if (!consultantId) return;
    try {
      const data = await AllocationService.fetchConsultantData(consultantId);
      setConsultantDetails(data);
    } catch (fetchError) {
      // AllocationService already reported it; the screen gets plain copy.
      console.error("Error fetching consultant details:", fetchError);
      setConsultantError(CALENDAR_LOAD_ERROR);
    } finally {
      setSettled((previous) =>
        previous.consultant ? previous : { ...previous, consultant: true },
      );
    }
  }, [consultantId]);

  const fetchAvailabilitySlots = useCallback(
    async (fetchOptions?: {
      /** A poll nobody asked for: fail silently and count it. */
      background?: boolean;
      /** Skip the browser HTTP cache — the caller just changed the data. */
      fresh?: boolean;
    }): Promise<PollFetchOutcome | void> => {
      if (!consultantId) return;

      const requestId = ++availabilityRequestIdRef.current;
      let settleInFlight: () => void = () => {};
      const inFlight = new Promise<void>((resolve) => {
        settleInFlight = resolve;
      });
      availabilityInFlightRef.current = inFlight;
      if (!fetchOptions?.background) setRefreshing(true);

      try {
        // The VISIBLE range, never the scheduling period: the period governs
        // selectability, and clamping the window to it blanked real cells.
        const { start: startDate, end: endDate } = dayRangeBounds(
          view === "week"
            ? startOfWeek(currentDate, { weekStartsOn })
            : startOfMonth(currentDate),
          view === "week"
            ? endOfWeek(currentDate, { weekStartsOn })
            : endOfMonth(currentDate),
          gridZone,
        );

        const data = await AllocationService.fetchAvailabilitySlots(
          consultantId,
          startDate,
          endDate,
          gridZone,
          includeAppointmentDetails,
          consulteeUserId,
          fetchOptions?.fresh,
          availabilityEtagRef.current,
          {
            webinarId: eventType === "webinar" ? eventId : undefined,
            classId: eventType === "class" ? eventId : undefined,
            subscriptionId: eventType === "subscription" ? eventId : undefined,
            releasing,
            lead: leadPurpose
              ? { purpose: leadPurpose, unpaid: leadUnpaid }
              : undefined,
          },
        );

        if (requestId !== availabilityRequestIdRef.current) return;
        // 304: nothing changed. Keep the state (and tag) as they are.
        if (data?.notModified) {
          availabilityFailedPollsRef.current = 0;
          lastSuccessAtRef.current = Date.now();
          setAvailabilityError(null);
          return;
        }
        if (!data || typeof data !== "object") {
          console.error("Unreadable availability response", data);
          setAvailabilityError(CALENDAR_LOAD_ERROR);
          return;
        }

        const validated = [
          ...(Array.isArray(data.weekly) ? data.weekly : []),
          ...(Array.isArray(data.custom) ? data.custom : []),
        ].filter(isValidRawSlot);

        // Stamped only once the body validated, so a rejected payload is never 304'd into place.
        availabilityEtagRef.current = data.etag ?? null;
        availabilityFailedPollsRef.current = 0;
        lastSuccessAtRef.current = Date.now();
        setRawSlots(validated);
        setCellsWindow({
          startMs: startDate.getTime(),
          endMs: endDate.getTime(),
        });
        setQuota(data.quota ?? null);
        setLeadMs(data.leadMs ?? null);
        setAvailabilityError(null);
        return { changed: true };
      } catch (fetchError) {
        if (requestId !== availabilityRequestIdRef.current) return;
        // AllocationService already reported it (refusals are not faults).
        console.error("Error fetching availability slots:", fetchError);
        if (fetchOptions?.background) {
          availabilityFailedPollsRef.current += 1;
          if (
            fetchError instanceof ApiResponseError &&
            fetchError.status === 429
          ) {
            return {
              rateLimitedForMs:
                fetchError.retryAfterMs ?? RATE_LIMIT_FALLBACK_BACKOFF_MS,
            };
          }
          return;
        }
        setAvailabilityError(CALENDAR_LOAD_ERROR);
      } finally {
        // Poll timing is measured from SETTLE, so a failing endpoint cannot
        // turn the 60 s poll into a hot loop.
        availabilityFetchedAtRef.current = Date.now();
        if (availabilityInFlightRef.current === inFlight) {
          availabilityInFlightRef.current = null;
        }
        if (requestId === availabilityRequestIdRef.current) {
          if (!fetchOptions?.background) setRefreshing(false);
          setSettled((previous) =>
            previous.availability
              ? previous
              : { ...previous, availability: true },
          );
        }
        settleInFlight();
      }
    },
    [
      consultantId,
      eventType,
      eventId,
      view,
      currentDate,
      consulteeUserId,
      includeAppointmentDetails,
      gridZone,
      weekStartsOn,
      releasing,
      leadPurpose,
      leadUnpaid,
    ],
  );

  const fetchEventSlots = useCallback(async (): Promise<void> => {
    if (!eventType || !eventId) {
      setEventSlots([]);
      setEventTentativeSlots([]);
      setEventOccurrences([]);
      setSubscriptionMeta(null);
      setEventSlotsFailed(false);
      return;
    }

    eventSlotsAbortRef.current?.abort();
    const controller = new AbortController();
    eventSlotsAbortRef.current = controller;
    try {
      const { data } = await AllocationService.fetchEventSlots(
        eventType,
        eventId,
        consultantId,
        controller.signal,
      );
      if (controller.signal.aborted) return;

      const activeData: Appointment[] = Array.isArray(data)
        ? data.filter((appt: Appointment) => {
            const dead = ["REJECTED", "CANCELLED", "EXPIRED"];
            if (
              appt.consultation?.status &&
              dead.includes(appt.consultation.status)
            )
              return false;
            if (
              appt.subscription?.status &&
              dead.includes(appt.subscription.status)
            )
              return false;
            if (appt.webinar?.status === "CANCELLED") return false;
            if (appt.class?.status === "CANCELLED") return false;
            return true;
          })
        : [];

      // Confirmed sessions (and a fresh request's own holds) paint "This
      // booking"; only genuine reschedule releases paint "Being moved". Each
      // session paints every atom it touches, so an off-grid start still
      // lines up with the server's 30-minute cells.
      const confirmedSlots: BookableInterval[] = [];
      const tentativeSlots: BookableInterval[] = [];
      for (const appointment of activeData) {
        for (const slot of appointment.occurrences ?? []) {
          // A returned or cancelled session no longer holds its time.
          if (slot.deletedAt || slot.completionStatus === "CANCELLED") continue;
          const startMs = new Date(slot.startsAt).getTime();
          const endMs = new Date(slot.endsAt).getTime();
          if (!Number.isFinite(startMs) || !(endMs > startMs)) continue;
          const target = isReleasedForReschedule(slot)
            ? tentativeSlots
            : confirmedSlots;
          for (
            let atom = Math.floor(startMs / ATOM) * ATOM;
            atom < endMs;
            atom += ATOM
          ) {
            target.push({
              startTime: new Date(atom),
              endTime: new Date(atom + ATOM),
              isAvailable: true,
              isBooked: true,
            });
          }
        }
      }
      setEventSlots(confirmedSlots);
      setEventTentativeSlots(tentativeSlots);
      setEventOccurrences(
        activeData.flatMap((appointment) =>
          (appointment.occurrences ?? []).map((slot) => ({
            id: slot.id ?? undefined,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
            completionStatus: slot.completionStatus ?? null,
            isTentative: slot.isTentative ?? false,
            deletedAt: slot.deletedAt ?? null,
          })),
        ),
      );
      setSubscriptionMeta(subscriptionMetaOf(activeData[0]?.subscription));
      setEventSlotsFailed(false);
    } catch (fetchError) {
      // Superseded by a newer read or unmounted: not a failure.
      if (controller.signal.aborted) return;
      // Keep the last good answer: zeroing it would paint this booking's own
      // sessions as someone else's and read the weekly counts as 0. The
      // calendar says so and the server re-checks every save.
      console.error("Error fetching event slots:", fetchError);
      setEventSlotsFailed(true);
    }
  }, [eventType, eventId, consultantId]);

  const fetchAllData = useCallback(async (): Promise<void> => {
    if (!consultantId) return;
    setConsultantError(null);
    setAvailabilityError(null);
    try {
      await Promise.all([
        fetchConsultantDetails(),
        fetchAvailabilitySlots({ fresh: true }),
        fetchEventSlots(),
      ]);
    } catch (fetchError) {
      // The fetchers self-catch; reaching here means that invariant broke.
      reportSentryError(fetchError, {
        subsystem: "client",
        tags: { feature: "scheduling-calendar" },
      });
      setConsultantError(CALENDAR_LOAD_ERROR);
    }
  }, [
    consultantId,
    fetchConsultantDetails,
    fetchAvailabilitySlots,
    fetchEventSlots,
  ]);

  // Date-independent reads: on open; the poll re-reads own sessions on a changed body.
  useEffect(() => {
    if (autoLoad && consultantId) {
      void fetchConsultantDetails();
      void fetchEventSlots();
    }
  }, [autoLoad, consultantId, fetchConsultantDetails, fetchEventSlots]);

  // Date-dependent read: on open and on every week/month navigation.
  useEffect(() => {
    if (autoLoad && consultantId) {
      void fetchAvailabilitySlots();
    }
  }, [autoLoad, consultantId, fetchAvailabilitySlots]);

  // Background freshness: ~60 s poll, paused while hidden, refetch on return.
  useEffect(() => {
    if (!autoLoad || !consultantId) return;
    if (typeof document === "undefined") return;

    const poller = createAvailabilityPoller({
      isEnabled: () => Boolean(autoLoad && consultantId),
      visibilityState: () => document.visibilityState,
      msSinceLastFetch: () => Date.now() - availabilityFetchedAtRef.current,
      inFlight: () => availabilityInFlightRef.current,
      fetch: async () => {
        const outcome = await fetchAvailabilitySlots({ background: true });
        // A changed body means something in the window moved, and this
        // booking's own sessions outrank the server cell: re-read them too.
        if (outcome?.changed || eventSlotsFailedRef.current) {
          void fetchEventSlots();
        }
        return outcome;
      },
      jitterMs: availabilityPollJitterMs,
    });

    const onReturn = () => poller.onReturn();
    const onVisibilityChange = () => poller.onVisibilityChange();

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onReturn);
    poller.arm();

    return () => {
      poller.dispose();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onReturn);
    };
  }, [autoLoad, consultantId, fetchAvailabilitySlots, fetchEventSlots]);

  // Explicit refetches (after a save, after a stay-open refusal) keep the grid
  // mounted: `refreshing` shows progress, `loading` is first paint only.
  const refetchAvailability = useCallback(
    () => fetchAvailabilitySlots({ fresh: true }).then(() => undefined),
    [fetchAvailabilitySlots],
  );

  return {
    consultantDetails,
    serverCells,
    availableSlots,
    eventSlots,
    eventTentativeSlots,
    eventOccurrences,
    subscriptionMeta,
    quota,
    leadMs,
    cellsWindow,
    loading: Boolean(
      autoLoad && consultantId && !(settled.consultant && settled.availability),
    ),
    refreshing,
    // Before any window has loaded there is nothing to keep on screen; after,
    // a failed refresh keeps the last cells and says so inline.
    error: consultantError ?? (cellsWindow === null ? availabilityError : null),
    refreshFailed: cellsWindow !== null && availabilityError !== null,
    eventSlotsFailed,
    availabilityFreshness: availabilityFreshnessState,
    refetch: fetchAllData,
    refetchAvailability,
    refetchEventSlots: fetchEventSlots,
  };
}
