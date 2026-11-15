import type { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import prisma from "lib/prisma";
import {
  PARTY_USER_SELECT,
  PROFILE_WITH_USER_SELECT,
} from "@/lib/booking/list-selects";
import { liveParticipant } from "@/lib/booking/participants";
import { getSession } from "@/lib/auth-server";
import { CLASS_PREFIX, WEBINAR_PREFIX } from "@/lib/stream-channel-ids";
import { bookingOrgId, getDmChannelId } from "@/lib/stream-utils";
import {
  dmEligibleStatusFilter,
  excludeNonDmDirectBooking,
  OPENABLE_EVENT_STATUSES,
} from "@/lib/stream/dm-eligibility-statuses";
import { buildBookingOrgScopeWhere } from "@/lib/stream/event-channel-service";
import { parseSearchDays, type DayRange } from "@/lib/stream/search-date";
import { resolveViewerZone } from "@/lib/time/viewer-zone";
import {
  MAX_SHORT_FIELD_LENGTH,
  MAX_TITLE_LENGTH,
} from "@/lib/validation/input-limits";
import {
  AppointmentSearchResultSchema,
  type AppointmentSearchResult,
} from "@/schemas/stream-search";

/**
 * Which conversations the caller may open, found by who, what and when.
 *
 * The rows offered are exactly the ones `/api/stream/channels/open` will accept:
 * the same booking statuses, trials excluded, and only the OTHER party's name or
 * email is searchable, never the caller's own.
 */

/** The shortest term the search acts on. */
const MIN_QUERY_LENGTH = 2;
/** Candidates read per booking kind before ranking; the response is capped below. */
const CANDIDATES_PER_KIND = 50;
/** Distinct conversations returned, and rows kept per conversation. */
const MAX_CHANNELS = 20;
const MAX_ROWS_PER_CHANNEL = 3;
/** `mode=people` is the New message picker: more rows, since it lists rather than searches. */
const PEOPLE_CANDIDATES_PER_KIND = 100;
const PEOPLE_MAX_CHANNELS = 50;
/** A cancelled or replaced session is not "on" a date any more. */
const DEAD_OCCURRENCE = ["CANCELLED", "RESCHEDULED"] as const;

const SearchParamsSchema = z.object({
  // The query is matched against titles, so nothing longer than one can match.
  q: z.string().trim().toLowerCase().max(MAX_TITLE_LENGTH),
  // An unusable zone falls back to UTC rather than failing the search.
  tz: z.string().max(MAX_SHORT_FIELD_LENGTH).nullable().catch(null),
  // People only: the New message picker. Without text it lists recent connections.
  mode: z.literal("people").nullable().catch(null),
});

type Party = { id: string; name: string | null; image: string | null };

const matches = (query: string) => ({
  contains: query,
  mode: "insensitive" as const,
});

const startsWithin = ({ start, end }: DayRange) => ({
  startsAt: { gte: start, lt: end },
});

/** Live sessions on any of `days`. */
const occursOn = (days: DayRange[]) => ({
  appointment: {
    occurrences: {
      some: {
        deletedAt: null,
        completionStatus: { notIn: [...DEAD_OCCURRENCE] },
        OR: days.map(startsWithin),
      },
    },
  },
});

/** The one session a row shows: the date-matched one, else the next upcoming. */
function occurrenceSelect(days: DayRange[], now: Date) {
  return {
    where: {
      deletedAt: null,
      completionStatus: { notIn: [...DEAD_OCCURRENCE] },
      ...(days.length > 0
        ? { OR: days.map(startsWithin) }
        : { startsAt: { gte: now } }),
    },
    orderBy: { startsAt: "asc" as const },
    take: 1,
    select: { startsAt: true },
  };
}

function consultationMatch(
  query: string,
  userId: string,
  days: DayRange[],
): Prisma.ConsultationWhereInput[] {
  return [
    { consultationPlan: { title: matches(query) } },
    {
      requestedBy: { userId },
      consultationPlan: {
        consultantProfile: { user: { name: matches(query) } },
      },
    },
    {
      consultationPlan: { consultantProfile: { userId } },
      requestedBy: {
        user: { OR: [{ name: matches(query) }, { email: matches(query) }] },
      },
    },
    ...(days.length > 0 ? [occursOn(days)] : []),
  ];
}

function subscriptionMatch(
  query: string,
  userId: string,
  days: DayRange[],
): Prisma.SubscriptionWhereInput[] {
  return [
    { subscriptionPlan: { title: matches(query) } },
    {
      requestedBy: { userId },
      subscriptionPlan: {
        consultantProfile: { user: { name: matches(query) } },
      },
    },
    {
      subscriptionPlan: { consultantProfile: { userId } },
      requestedBy: {
        user: { OR: [{ name: matches(query) }, { email: matches(query) }] },
      },
    },
    ...(days.length > 0 ? [occursOn(days)] : []),
  ];
}

function webinarMatch(
  query: string,
  userId: string,
  days: DayRange[],
): Prisma.WebinarWhereInput[] {
  return [
    { webinarPlan: { title: matches(query) } },
    {
      webinarPlan: {
        consultantProfile: {
          userId: { not: userId },
          user: { name: matches(query) },
        },
      },
    },
    ...(days.length > 0 ? [occursOn(days)] : []),
  ];
}

function classMatch(
  query: string,
  userId: string,
  days: DayRange[],
): Prisma.ClassWhereInput[] {
  return [
    { classPlan: { title: matches(query) } },
    {
      classPlan: {
        consultantProfile: {
          userId: { not: userId },
          user: { name: matches(query) },
        },
      },
    },
    ...(days.length > 0 ? [occursOn(days)] : []),
  ];
}

/**
 * The OTHER party, relative to whoever is signed in. Labelling every row with the
 * consultant named the viewer on a consultant's own dashboard.
 */
function resolveCounterparty(
  viewerUserId: string,
  consultant: Party,
  consultee: Party,
): {
  counterpartyUserId: string;
  counterpartyName: string;
  counterpartyImage?: string;
} {
  const other = consultant.id === viewerUserId ? consultee : consultant;
  return {
    counterpartyUserId: other.id,
    counterpartyName: other.name || "Unknown",
    counterpartyImage: other.image || undefined,
  };
}

type DirectHit = {
  kind: "consultation" | "subscription";
  id: string;
  title: string;
  consultant: Party;
  consultee: Party & { email: string | null };
  organizationId: string | null;
  startsAt: Date | undefined;
};

function directRow(
  hit: DirectHit,
  userId: string,
  query: string,
): AppointmentSearchResult | null {
  // `getDmChannelId` throws on a self-pair, and one legacy self-booked row must
  // not fail the whole search.
  if (hit.consultant.id === hit.consultee.id) return null;

  const emailMatched =
    query !== "" &&
    hit.consultant.id === userId &&
    Boolean(hit.consultee.email?.toLowerCase().includes(query)) &&
    !hit.consultee.name?.toLowerCase().includes(query) &&
    !hit.title.toLowerCase().includes(query);

  return {
    id: hit.id,
    type: hit.kind,
    name: hit.title,
    ...resolveCounterparty(userId, hit.consultant, hit.consultee),
    organizationId: hit.organizationId,
    // The funding context is part of the DM key, so the id must come from the
    // same resolver the channel creators use.
    channelId: getDmChannelId(
      hit.consultant.id,
      hit.consultee.id,
      hit.organizationId,
    ),
    ...(hit.startsAt ? { startsAt: hit.startsAt.toISOString() } : {}),
    ...(emailMatched && hit.consultee.email
      ? { counterpartyEmail: hit.consultee.email }
      : {}),
  };
}

function eventRow(
  kind: "webinar" | "class",
  event: {
    id: string;
    title: string;
    host: Party | undefined;
    startsAt: Date | undefined;
  },
): AppointmentSearchResult | null {
  if (!event.host) return null;
  return {
    id: event.id,
    type: kind,
    name: event.title,
    // A group event has no single counterparty, so the host stands in.
    counterpartyName: event.host.name || "Unknown",
    counterpartyImage: event.host.image || undefined,
    channelId: `${kind === "webinar" ? WEBINAR_PREFIX : CLASS_PREFIX}${event.id}`,
    ...(event.startsAt ? { startsAt: event.startsAt.toISOString() } : {}),
  };
}

/** A word of `text` starts with `query`, so "ka" ranks Karen above Frank. */
function hasWordPrefix(text: string, query: string): boolean {
  const lower = text.toLowerCase();
  return lower.startsWith(query) || lower.includes(` ${query}`);
}

function matchRank(
  row: AppointmentSearchResult,
  query: string,
  searchedByDate: boolean,
): 0 | 1 {
  const strong =
    (searchedByDate && row.startsAt !== undefined) ||
    hasWordPrefix(row.counterpartyName, query) ||
    hasWordPrefix(row.name, query);
  return strong ? 0 : 1;
}

/**
 * Cap by conversation, not by row: one person's ten bookings must not push every
 * other match out of the list.
 */
function limitByChannel(
  rows: AppointmentSearchResult[],
  maxChannels: number,
): AppointmentSearchResult[] {
  const perChannel = new Map<string, number>();
  const kept: AppointmentSearchResult[] = [];
  for (const row of rows) {
    const count = perChannel.get(row.channelId) ?? 0;
    if (count === 0 && perChannel.size >= maxChannels) continue;
    if (count >= MAX_ROWS_PER_CHANNEL) continue;
    perChannel.set(row.channelId, count + 1);
    kept.push(row);
  }
  return kept;
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be logged in to search appointments" },
        { status: 401 },
      );
    }

    const userId = session.user.id;
    const searchParams =
      request.nextUrl?.searchParams ?? new URL(request.url).searchParams;
    const params = SearchParamsSchema.safeParse({
      q: searchParams.get("q") ?? "",
      tz: searchParams.get("tz"),
      mode: searchParams.get("mode"),
    });
    if (!params.success) {
      return NextResponse.json([]);
    }
    const peopleOnly = params.data.mode === "people";
    // A term too short to act on lists everyone in people mode and nothing otherwise.
    const query = params.data.q.length >= MIN_QUERY_LENGTH ? params.data.q : "";
    if (!query && !peopleOnly) {
      return NextResponse.json([]);
    }
    const candidates = peopleOnly
      ? PEOPLE_CANDIDATES_PER_KIND
      : CANDIDATES_PER_KIND;

    const now = new Date();
    const days = query
      ? parseSearchDays(
          query,
          now,
          resolveViewerZone({ userTimezone: params.data.tz }),
        )
      : [];
    const occurrences = occurrenceSelect(days, now);

    const consultationScopeWhere = buildBookingOrgScopeWhere(
      searchParams,
      "consultationPlan",
    );
    const subscriptionScopeWhere = buildBookingOrgScopeWhere(
      searchParams,
      "subscriptionPlan",
    );
    const webinarScopeWhere = buildBookingOrgScopeWhere(
      searchParams,
      "webinarPlan",
    );
    const classScopeWhere = buildBookingOrgScopeWhere(
      searchParams,
      "classPlan",
    );

    // Newest-first with an id tiebreak, so the same search returns the same rows.
    const newestFirst = [
      { createdAt: "desc" as const },
      { id: "asc" as const },
    ];

    const consultationsPromise = prisma.consultation.findMany({
      where: {
        AND: [
          ...(query ? [{ OR: consultationMatch(query, userId, days) }] : []),
          { status: dmEligibleStatusFilter() },
          // `/open` refuses a trial booking, so offering one is a dead row.
          excludeNonDmDirectBooking(),
          {
            OR: [
              { requestedBy: { userId } },
              { consultationPlan: { consultantProfile: { userId } } },
            ],
          },
          ...(consultationScopeWhere ? [consultationScopeWhere] : []),
        ],
      },
      select: {
        id: true,
        createdAt: true,
        consultationPlan: {
          select: {
            title: true,
            organizationId: true,
            consultantProfile: PROFILE_WITH_USER_SELECT,
          },
        },
        requestedBy: { select: { user: PARTY_USER_SELECT } },
        appointment: { select: { organizationId: true, occurrences } },
      },
      orderBy: newestFirst,
      take: candidates,
    });

    const subscriptionsPromise = prisma.subscription.findMany({
      where: {
        AND: [
          ...(query ? [{ OR: subscriptionMatch(query, userId, days) }] : []),
          { status: dmEligibleStatusFilter() },
          excludeNonDmDirectBooking(),
          {
            OR: [
              { requestedBy: { userId } },
              { subscriptionPlan: { consultantProfile: { userId } } },
            ],
          },
          ...(subscriptionScopeWhere ? [subscriptionScopeWhere] : []),
        ],
      },
      select: {
        id: true,
        createdAt: true,
        subscriptionPlan: {
          select: {
            title: true,
            organizationId: true,
            consultantProfile: PROFILE_WITH_USER_SELECT,
          },
        },
        requestedBy: { select: { user: PARTY_USER_SELECT } },
        // One wrapper per subscription carries the org tag and every session.
        appointment: { select: { organizationId: true, occurrences } },
      },
      orderBy: newestFirst,
      take: candidates,
    });

    const webinarsPromise = peopleOnly
      ? Promise.resolve([])
      : prisma.webinar.findMany({
          where: {
            AND: [
              ...(query ? [{ OR: webinarMatch(query, userId, days) }] : []),
              { status: { in: [...OPENABLE_EVENT_STATUSES] } },
              {
                OR: [
                  // Holds a seat, hosts, or is an accepted collaborator.
                  {
                    appointment: {
                      participants: { some: liveParticipant(userId) },
                    },
                  },
                  { webinarPlan: { consultantProfile: { userId } } },
                  {
                    webinarPlan: {
                      collaborators: {
                        some: {
                          consultantProfile: { userId, deletedAt: null },
                          status: "ACCEPTED",
                        },
                      },
                    },
                  },
                ],
              },
              ...(webinarScopeWhere ? [webinarScopeWhere] : []),
            ],
          },
          select: {
            id: true,
            webinarPlan: {
              select: {
                title: true,
                consultantProfile: PROFILE_WITH_USER_SELECT,
              },
            },
            appointment: { select: { occurrences } },
          },
          orderBy: newestFirst,
          take: candidates,
        });

    const classesPromise = peopleOnly
      ? Promise.resolve([])
      : prisma.class.findMany({
          where: {
            AND: [
              ...(query ? [{ OR: classMatch(query, userId, days) }] : []),
              { status: { in: [...OPENABLE_EVENT_STATUSES] } },
              {
                OR: [
                  {
                    appointment: {
                      participants: { some: liveParticipant(userId) },
                    },
                  },
                  { classPlan: { consultantProfile: { userId } } },
                  {
                    classPlan: {
                      collaborators: {
                        some: {
                          consultantProfile: { userId, deletedAt: null },
                          status: "ACCEPTED",
                        },
                      },
                    },
                  },
                ],
              },
              ...(classScopeWhere ? [classScopeWhere] : []),
            ],
          },
          select: {
            id: true,
            classPlan: {
              select: {
                title: true,
                consultantProfile: PROFILE_WITH_USER_SELECT,
              },
            },
            appointment: { select: { occurrences } },
          },
          orderBy: newestFirst,
          take: candidates,
        });

    // The four reads are independent, so they are issued together.
    const [consultations, subscriptions, webinars, classes] = await Promise.all(
      [
        consultationsPromise,
        subscriptionsPromise,
        webinarsPromise,
        classesPromise,
      ],
    );

    const results: AppointmentSearchResult[] = [];
    // When each booking was made, so the picker can keep the newest connections.
    const bookedAt = new Map<AppointmentSearchResult, number>();
    const push = (row: AppointmentSearchResult | null, createdAt?: Date) => {
      if (!row) return;
      results.push(row);
      if (createdAt) bookedAt.set(row, createdAt.getTime());
    };

    for (const consultation of consultations) {
      push(
        directRow(
          {
            kind: "consultation",
            id: consultation.id,
            title: consultation.consultationPlan.title,
            consultant: consultation.consultationPlan.consultantProfile.user,
            consultee: consultation.requestedBy.user,
            organizationId: bookingOrgId(consultation),
            startsAt: consultation.appointment?.occurrences[0]?.startsAt,
          },
          userId,
          query,
        ),
        consultation.createdAt,
      );
    }

    for (const subscription of subscriptions) {
      push(
        directRow(
          {
            kind: "subscription",
            id: subscription.id,
            title: subscription.subscriptionPlan.title,
            consultant: subscription.subscriptionPlan.consultantProfile.user,
            consultee: subscription.requestedBy.user,
            organizationId: bookingOrgId(subscription),
            startsAt: subscription.appointment?.occurrences[0]?.startsAt,
          },
          userId,
          query,
        ),
        subscription.createdAt,
      );
    }

    for (const webinar of webinars) {
      push(
        eventRow("webinar", {
          id: webinar.id,
          title: webinar.webinarPlan.title,
          host: webinar.webinarPlan.consultantProfile?.user,
          startsAt: webinar.appointment?.occurrences[0]?.startsAt,
        }),
      );
    }

    for (const classItem of classes) {
      push(
        eventRow("class", {
          id: classItem.id,
          title: classItem.classPlan.title,
          host: classItem.classPlan.consultantProfile?.user,
          startsAt: classItem.appointment?.occurrences[0]?.startsAt,
        }),
      );
    }

    const byPerson = (a: AppointmentSearchResult, b: AppointmentSearchResult) =>
      a.counterpartyName.localeCompare(b.counterpartyName) ||
      a.name.localeCompare(b.name);

    let ordered: AppointmentSearchResult[];
    if (peopleOnly && !query) {
      // Nothing was typed, so keep the newest connections under the cap and only
      // then list them by name. Sorting by name first cut off recent people late
      // in the alphabet.
      ordered = limitByChannel(
        results.sort((a, b) => (bookedAt.get(b) ?? 0) - (bookedAt.get(a) ?? 0)),
        PEOPLE_MAX_CHANNELS,
      ).sort(byPerson);
    } else {
      // Best match first, then by person and title. `sort` is stable.
      const searchedByDate = days.length > 0;
      results.sort(
        (a, b) =>
          matchRank(a, query, searchedByDate) -
            matchRank(b, query, searchedByDate) || byPerson(a, b),
      );
      ordered = limitByChannel(
        results,
        peopleOnly ? PEOPLE_MAX_CHANNELS : MAX_CHANNELS,
      );
    }

    // Parsed on the way out: the dropdown derives its type from this schema, so
    // a field renamed here fails at the boundary rather than rendering blank.
    return NextResponse.json(
      AppointmentSearchResultSchema.array().parse(ordered),
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "stream" } },
    );
    console.error("Error searching appointments:", error);
    return NextResponse.json(
      { error: "Failed to search appointments" },
      { status: 500 },
    );
  }
}
