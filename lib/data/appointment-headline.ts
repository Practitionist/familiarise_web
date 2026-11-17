/**
 * What a back-office row says about a booking: its title, its expert, its
 * learner (or its live roster for a webinar or class) and its lifecycle
 * status, read through one select fragment and one batched user read.
 */

import type { AppointmentsType, BookingSource, Prisma } from "@prisma/client";

import { liveParticipant } from "@/lib/booking/participants";

const USER_ID = { select: { userId: true } } as const;

/** The polymorphic fields a headline reads; people are ids, resolved in one batch. */
export const APPOINTMENT_HEADLINE_SELECT = {
  appointmentType: true,
  deletedAt: true,
  // The attendee count is the live participant roster.
  _count: { select: { participants: { where: liveParticipant() } } },
  consultation: {
    select: {
      id: true,
      status: true,
      bookingSource: true,
      consultationPlan: {
        select: {
          id: true,
          title: true,
          price: true,
          priceCurrency: true,
          durationInHours: true,
          consultantProfile: USER_ID,
        },
      },
      requestedBy: USER_ID,
    },
  },
  subscription: {
    select: {
      id: true,
      status: true,
      bookingSource: true,
      subscriptionPlan: {
        select: {
          id: true,
          title: true,
          price: true,
          priceCurrency: true,
          consultantProfile: USER_ID,
        },
      },
      requestedBy: USER_ID,
    },
  },
  trial: {
    select: {
      status: true,
      agreedPricePaise: true,
      subscriptionPlan: {
        select: {
          title: true,
          trialPriceInPaise: true,
          trialDurationMinutes: true,
        },
      },
      // The trial's own host, who may not be the plan's author.
      consultantProfile: USER_ID,
      consulteeProfile: USER_ID,
    },
  },
  webinar: {
    select: {
      id: true,
      status: true,
      webinarPlan: {
        select: {
          id: true,
          title: true,
          price: true,
          priceCurrency: true,
          maxParticipants: true,
          consultantProfile: USER_ID,
        },
      },
    },
  },
  class: {
    select: {
      id: true,
      status: true,
      classPlan: {
        select: {
          id: true,
          title: true,
          price: true,
          priceCurrency: true,
          maxParticipants: true,
          consultantProfile: USER_ID,
        },
      },
    },
  },
} satisfies Prisma.AppointmentSelect;

export interface HeadlineUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

export interface AppointmentHeadline {
  title: string;
  expert: HeadlineUser | null;
  /** The 1:1 learner; null on a webinar or class, which carries `attendeeLabel`. */
  learner: HeadlineUser | null;
  /** "12 attendees" / "1 student" for a webinar or class; null for a 1:1. */
  attendeeLabel: string | null;
  /** The stored status of the booking's lifecycle row; null when that row is gone. */
  lifecycleStatus: string | null;
  bookingSource: BookingSource | null;
  durationMinutes: number;
}

type UserRef = { userId: string };

/** The fields of {@link APPOINTMENT_HEADLINE_SELECT} a headline reads; money columns may arrive as number or bigint. */
export interface HeadlineInput {
  appointmentType: AppointmentsType;
  _count: { participants: number };
  consultation: {
    status: string;
    bookingSource: BookingSource | null;
    consultationPlan: {
      title: string;
      durationInHours: number;
      consultantProfile: UserRef;
    };
    requestedBy: UserRef;
  } | null;
  subscription: {
    status: string;
    bookingSource: BookingSource | null;
    subscriptionPlan: { title: string; consultantProfile: UserRef };
    requestedBy: UserRef;
  } | null;
  trial: HeadlineTrial | null;
  webinar: {
    status: string;
    webinarPlan: { title: string; consultantProfile: UserRef | null };
  } | null;
  class: {
    status: string;
    classPlan: { title: string; consultantProfile: UserRef | null };
  } | null;
}

interface HeadlineTrial {
  status: string;
  agreedPricePaise: number | bigint | null;
  subscriptionPlan: {
    title: string;
    trialPriceInPaise: number | bigint;
    trialDurationMinutes: number;
  };
  consultantProfile: UserRef;
  consulteeProfile: UserRef;
}

function attendeeLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Every user id a page of headlines names, for the one batched `user.findMany`. */
export function headlineUserIds(rows: readonly HeadlineInput[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const id of [
      row.consultation?.consultationPlan.consultantProfile.userId,
      row.consultation?.requestedBy.userId,
      row.subscription?.subscriptionPlan.consultantProfile.userId,
      row.subscription?.requestedBy.userId,
      row.webinar?.webinarPlan.consultantProfile?.userId,
      row.class?.classPlan.consultantProfile?.userId,
      row.trial?.consultantProfile.userId,
      row.trial?.consulteeProfile.userId,
    ]) {
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/** The trial price the buyer agreed to, else the plan's (rows from before the column). */
export function trialPricePaise(trial: HeadlineTrial): number {
  return Number(
    trial.agreedPricePaise ?? trial.subscriptionPlan.trialPriceInPaise,
  );
}

/** One booking's headline; a trial wrapper whose trial row is gone says so in its title. */
export function appointmentHeadline(
  row: HeadlineInput,
  usersById: ReadonlyMap<string, HeadlineUser>,
): AppointmentHeadline {
  const userOf = (id: string | null | undefined) =>
    (id && usersById.get(id)) || null;
  const empty: AppointmentHeadline = {
    title: "",
    expert: null,
    learner: null,
    attendeeLabel: null,
    lifecycleStatus: null,
    bookingSource: null,
    durationMinutes: 0,
  };
  const attendees = row._count.participants;
  switch (row.appointmentType) {
    case "TRIAL": {
      const t = row.trial;
      if (!t) return { ...empty, title: "Trial (record removed)" };
      return {
        ...empty,
        title: t.subscriptionPlan.title,
        expert: userOf(t.consultantProfile.userId),
        learner: userOf(t.consulteeProfile.userId),
        lifecycleStatus: t.status,
        durationMinutes: t.subscriptionPlan.trialDurationMinutes,
      };
    }
    case "CONSULTATION": {
      const c = row.consultation;
      if (!c) return empty;
      return {
        ...empty,
        title: c.consultationPlan.title,
        expert: userOf(c.consultationPlan.consultantProfile.userId),
        learner: userOf(c.requestedBy.userId),
        lifecycleStatus: c.status,
        bookingSource: c.bookingSource,
        durationMinutes: c.consultationPlan.durationInHours * 60,
      };
    }
    case "SUBSCRIPTION": {
      const s = row.subscription;
      if (!s) return empty;
      return {
        ...empty,
        title: s.subscriptionPlan.title,
        expert: userOf(s.subscriptionPlan.consultantProfile.userId),
        learner: userOf(s.requestedBy.userId),
        lifecycleStatus: s.status,
        bookingSource: s.bookingSource,
      };
    }
    case "WEBINAR": {
      const w = row.webinar;
      if (!w) return empty;
      return {
        ...empty,
        title: w.webinarPlan.title,
        expert: userOf(w.webinarPlan.consultantProfile?.userId),
        attendeeLabel: attendeeLabel(attendees, "attendee"),
        lifecycleStatus: w.status,
      };
    }
    case "CLASS": {
      const k = row.class;
      if (!k) return empty;
      return {
        ...empty,
        title: k.classPlan.title,
        expert: userOf(k.classPlan.consultantProfile?.userId),
        attendeeLabel: attendeeLabel(attendees, "student"),
        lifecycleStatus: k.status,
      };
    }
  }
}
