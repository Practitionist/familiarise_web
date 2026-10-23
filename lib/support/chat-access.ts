/**
 * Case-linked staff access to a booking chat: who may read it, which channel
 * and whose messages a grant covers, and the status the staff panel shows.
 * Pure DB reads and resolution; Stream calls live in lib/stream/support-intervention.ts.
 */

import type { Prisma } from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { liveParticipant } from "@/lib/booking/participants";
import { resolveCanonicalMeetingChannel } from "@/lib/meetings/mirror-room-chat";
import type {
  ChatGrant,
  ChatParty,
  ChatStatus,
  SupportChatInterventionBasis,
} from "@/schemas/support-chat";
import { deliveringPartiesByAppointment } from "./evidence-parties";

const HOUR_MS = 3_600_000;
/** A 1:1 DM outlives one booking: the window opens a week before the booking was made. */
export const CHAT_DM_LEAD_IN_MS = 7 * 24 * HOUR_MS;
export const CHAT_READ_TTL_MS = 24 * HOUR_MS;
const OPEN_STATUSES = new Set(["OPEN", "IN_PROGRESS", "ESCALATED"]);
const GRANT_LIST_CAP = 50;

export const CASE_CHAT_SELECT = {
  id: true,
  referenceNumber: true,
  title: true,
  status: true,
  deletedAt: true,
  activeChannel: true,
  appointmentId: true,
  category: true,
  requesterUserId: true,
  submitterUserId: true,
  organizationId: true,
  ownershipScope: true,
  externalRequesterEmail: true,
} satisfies Prisma.SupportCaseSelect;

export type ChatCase = Prisma.SupportCaseGetPayload<{
  select: typeof CASE_CHAT_SELECT;
}>;

type ChatDb = Pick<
  Tx,
  "appointment" | "appointmentParticipant" | "consultantProfile"
>;

export interface CaseChat {
  channelType: "messaging" | "team";
  channelId: string;
  kind: "DM" | "GROUP";
  appointmentId: string;
  windowStart: Date;
  /** Sponsor and host tenants; each gets an OrgAuditLog row (no content) per grant. */
  organizationIds: string[];
  /** Both members of a 1:1 DM; empty for a group channel. */
  dmPair: string[];
  deliveringIds: string[];
  attendeeIds: string[];
  /** The case's requester when they are a party to this chat. */
  reporterId: string | null;
}

const refuse = (code: string, message: string, status = 409) =>
  new OpsRefusal(code, message, status);

export function caseNotFound() {
  return refuse("CASE_NOT_FOUND", "Support case not found.", 404);
}

/** Why a case can't open its booking chat at all, or null. */
export function caseChatRefusal(
  supportCase: Pick<
    ChatCase,
    "deletedAt" | "status" | "activeChannel" | "appointmentId"
  >,
): OpsRefusal | null {
  if (supportCase.deletedAt) return caseNotFound();
  if (!OPEN_STATUSES.has(supportCase.status))
    return refuse(
      "CASE_NOT_OPEN",
      "Booking chat can only be opened on an open case.",
    );
  if (supportCase.activeChannel !== "HUMAN")
    return refuse(
      "CASE_NOT_HUMAN",
      "Escalate the case to a person before opening the booking chat.",
    );
  if (!supportCase.appointmentId)
    return refuse("NO_BOOKING", "This case is not linked to a booking.");
  return null;
}

const APPOINTMENT_CHAT_SELECT = {
  id: true,
  createdAt: true,
  appointmentType: true,
  organizationId: true,
  consultation: {
    select: {
      consultationPlan: {
        select: {
          organizationId: true,
          consultantProfile: { select: { userId: true } },
        },
      },
    },
  },
  subscription: {
    select: {
      subscriptionPlan: {
        select: {
          organizationId: true,
          consultantProfile: { select: { userId: true } },
        },
      },
    },
  },
  webinar: {
    select: { id: true, webinarPlan: { select: { organizationId: true } } },
  },
  class: {
    select: { id: true, classPlan: { select: { organizationId: true } } },
  },
} satisfies Prisma.AppointmentSelect;

/** The booking's canonical chat and its parties; throws a typed refusal when there is none. */
export async function resolveCaseChat(
  db: ChatDb,
  supportCase: Pick<ChatCase, "appointmentId" | "requesterUserId">,
): Promise<CaseChat> {
  const appointment = supportCase.appointmentId
    ? await db.appointment.findFirst({
        where: { id: supportCase.appointmentId, deletedAt: null },
        select: APPOINTMENT_CHAT_SELECT,
      })
    : null;
  if (!appointment)
    throw refuse("NO_BOOKING", "This case is not linked to a booking.");
  if (appointment.appointmentType === "TRIAL")
    throw refuse("CHAT_DISABLED", "Free trial bookings have no chat.");
  const channel = await resolveCanonicalMeetingChannel(appointment, db);
  if (!channel || channel.channelId.startsWith("collab-"))
    throw refuse("CHAT_NOT_FOUND", "This booking has no chat.", 404);

  const [parties, attendees] = await Promise.all([
    deliveringPartiesByAppointment(db, [appointment.id]),
    db.appointmentParticipant.findMany({
      where: {
        appointmentId: appointment.id,
        role: "CONSULTEE",
        ...liveParticipant(),
      },
      select: { userId: true },
    }),
  ]);
  const booking = parties.get(appointment.id);
  const organizationIds = [
    ...new Set(
      [
        appointment.organizationId,
        appointment.consultation?.consultationPlan.organizationId,
        appointment.subscription?.subscriptionPlan.organizationId,
        appointment.webinar?.webinarPlan.organizationId,
        appointment.class?.classPlan.organizationId,
        ...(booking?.hostOrganizationIds ?? []),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
  const dmPair =
    channel.channelType === "messaging" &&
    channel.consultantUserId &&
    channel.consulteeUserId
      ? [channel.consulteeUserId, channel.consultantUserId]
      : [];
  const deliveringIds = [...(booking?.deliveringIds ?? [])];
  const attendeeIds = [...new Set(attendees.map((a) => a.userId))].filter(
    (userId) => !deliveringIds.includes(userId),
  );
  const everyone = new Set([...dmPair, ...deliveringIds, ...attendeeIds]);
  return {
    channelType: channel.channelType,
    channelId: channel.channelId,
    kind: channel.channelType === "messaging" ? "DM" : "GROUP",
    appointmentId: appointment.id,
    windowStart: new Date(appointment.createdAt.getTime() - CHAT_DM_LEAD_IN_MS),
    organizationIds,
    dmPair,
    deliveringIds,
    attendeeIds,
    reporterId: everyone.has(supportCase.requesterUserId)
      ? supportCase.requesterUserId
      : null,
  };
}

function partyRole(chat: CaseChat, userId: string): ChatParty["role"] {
  if (userId === chat.reporterId) return "REPORTER";
  return chat.deliveringIds.includes(userId) ? "DELIVERING" : "ATTENDEE";
}

/** Group channels need staff-picked targets unless an attendee filed the case. */
export function requiresTargets(chat: CaseChat): boolean {
  if (chat.kind === "DM") return false;
  return !chat.reporterId || !chat.attendeeIds.includes(chat.reporterId);
}

/**
 * Whose messages a grant covers. A DM covers both members. A group channel
 * covers the reporter and the targets: staff-picked parties, or the delivering
 * parties when an attendee reports and staff pick nobody.
 */
export function scopeFor(chat: CaseChat, targetUserIds: string[] = []) {
  if (chat.kind === "DM") {
    if (targetUserIds.some((id) => !chat.dmPair.includes(id)))
      throw refuse(
        "TARGET_NOT_PARTY",
        "Pick people who are in this booking chat.",
        400,
      );
    return [...chat.dmPair];
  }
  const parties = new Set([...chat.deliveringIds, ...chat.attendeeIds]);
  if (targetUserIds.some((id) => !parties.has(id)))
    throw refuse(
      "TARGET_NOT_PARTY",
      "Pick people who are in this booking.",
      400,
    );
  const targets = targetUserIds.filter((id) => id !== chat.reporterId);
  if (requiresTargets(chat) && targets.length === 0)
    throw refuse(
      "TARGETS_REQUIRED",
      "Pick who the case is about in this group session.",
      400,
    );
  const scope = new Set<string>();
  if (chat.reporterId) scope.add(chat.reporterId);
  for (const id of targets.length ? targets : chat.deliveringIds) scope.add(id);
  if (scope.size === 0)
    throw refuse(
      "TARGETS_REQUIRED",
      "Pick who the case is about in this group session.",
      400,
    );
  return [...scope];
}

type BasisDb = Pick<Tx, "supportCaseEvidenceRequest">;

/** Intervention bases the server can verify today: overdue evidence, and a SAFETY_CONCERN intake. */
export async function verifiedInterventionBases(
  db: BasisDb,
  supportCase: Pick<ChatCase, "id" | "category">,
  now: Date,
): Promise<SupportChatInterventionBasis[]> {
  const overdue = await db.supportCaseEvidenceRequest.findFirst({
    where: {
      caseId: supportCase.id,
      respondedAt: null,
      cancelledAt: null,
      dueAt: { lte: now },
    },
    select: { id: true },
  });
  const bases: SupportChatInterventionBasis[] = [];
  if (overdue) bases.push("EVIDENCE_OVERDUE");
  if (supportCase.category === "SAFETY_CONCERN")
    bases.push("SAFETY", "FRAUD_OR_SCAM");
  return bases;
}

/**
 * Evidence-overdue must be verified; a safety, fraud or scam basis is verified
 * by a SAFETY_CONCERN intake or asserted by staff (the reason is in OpsActionLog).
 */
export function interventionBasisSource(
  basis: SupportChatInterventionBasis,
  verified: SupportChatInterventionBasis[],
): "VERIFIED" | "ASSERTED" {
  if (verified.includes(basis)) return "VERIFIED";
  if (basis === "EVIDENCE_OVERDUE")
    throw refuse(
      "BASIS_NOT_MET",
      "No evidence request on this case is overdue.",
    );
  return "ASSERTED";
}

export const GRANT_SELECT = {
  id: true,
  caseId: true,
  kind: true,
  basis: true,
  grantedById: true,
  grantedBy: { select: { name: true } },
  channelType: true,
  channelId: true,
  scopeUserIds: true,
  windowStart: true,
  organizationIds: true,
  withholdNotice: true,
  expiresAt: true,
  endedAt: true,
  endReason: true,
  streamJoinedAt: true,
  streamLeftAt: true,
  createdAt: true,
} satisfies Prisma.SupportCaseChatAccessSelect;

export type GrantRow = Prisma.SupportCaseChatAccessGetPayload<{
  select: typeof GRANT_SELECT;
}>;

export function isLiveGrant(
  grant: { endedAt: Date | null; expiresAt: Date },
  now: Date,
): boolean {
  return grant.endedAt === null && grant.expiresAt > now;
}

export function projectGrant(
  grant: Omit<GrantRow, "grantedBy"> & { grantedBy?: { name: string } | null },
  actorId: string,
  now: Date,
): ChatGrant {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    id: grant.id,
    kind: grant.kind,
    basis: grant.basis,
    grantedById: grant.grantedById,
    grantedByName: grant.grantedBy?.name ?? null,
    mine: grant.grantedById === actorId,
    live: isLiveGrant(grant, now),
    windowStart: grant.windowStart.toISOString(),
    expiresAt: grant.expiresAt.toISOString(),
    endedAt: iso(grant.endedAt),
    endReason: grant.endReason,
    streamJoinedAt: iso(grant.streamJoinedAt),
    streamLeftAt: iso(grant.streamLeftAt),
    withholdNotice: grant.withholdNotice,
    createdAt: grant.createdAt.toISOString(),
  };
}

/**
 * The grant a transcript read runs under: live, on this case, and opened by
 * the caller. An intervention also lets the operator who opened it read.
 */
export async function liveGrantForReader(
  db: Pick<Tx, "supportCaseChatAccess">,
  input: { caseId: string; grantId: string; actorId: string; now: Date },
): Promise<GrantRow> {
  const grant = await db.supportCaseChatAccess.findFirst({
    where: {
      id: input.grantId,
      caseId: input.caseId,
      grantedById: input.actorId,
    },
    select: GRANT_SELECT,
  });
  if (!grant) throw refuse("GRANT_NOT_FOUND", "Chat access not found.", 404);
  if (!isLiveGrant(grant, input.now))
    throw refuse(
      "GRANT_ENDED",
      "This chat access has ended; open a new one with a reason.",
      410,
    );
  return grant;
}

type StatusDb = ChatDb &
  Pick<
    Tx,
    | "supportCase"
    | "supportCaseChatAccess"
    | "supportCaseEvidenceRequest"
    | "user"
  >;

function refusalOf(err: unknown) {
  if (err instanceof OpsRefusal)
    return { ok: false as const, code: err.code, message: err.message };
  throw err;
}

/** What the staff chat panel shows: eligibility, parties for the target picker, and grants. */
export async function readCaseChatStatus(
  db: StatusDb,
  input: { caseId: string; actorId: string; canIntervene: boolean; now: Date },
): Promise<ChatStatus | null> {
  const supportCase = await db.supportCase.findUnique({
    where: { id: input.caseId },
    select: CASE_CHAT_SELECT,
  });
  if (!supportCase || supportCase.deletedAt) return null;
  const grants = await db.supportCaseChatAccess.findMany({
    where: { caseId: input.caseId },
    orderBy: { createdAt: "desc" },
    take: GRANT_LIST_CAP,
    select: GRANT_SELECT,
  });
  const base = {
    grants: grants.map((g) => projectGrant(g, input.actorId, input.now)),
    canIntervene: input.canIntervene,
  };
  const refusal = caseChatRefusal(supportCase);
  let chat: CaseChat | null = null;
  let readRefusal = refusal ? refusalOf(refusal) : null;
  if (!readRefusal) {
    try {
      chat = await resolveCaseChat(db, supportCase);
    } catch (err) {
      readRefusal = refusalOf(err);
    }
  }
  if (!chat || readRefusal) {
    const r = readRefusal ?? refusalOf(caseNotFound());
    return {
      ...base,
      channel: null,
      read: r,
      intervene: r,
      requiresTargets: false,
      parties: [],
    };
  }
  const partyIds = [
    ...new Set([...chat.dmPair, ...chat.deliveringIds, ...chat.attendeeIds]),
  ];
  const users = partyIds.length
    ? await db.user.findMany({
        where: { id: { in: partyIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const parties: ChatParty[] = partyIds.map((userId) => ({
    userId,
    name: nameOf.get(userId) ?? "Former user",
    role: partyRole(chat, userId),
  }));
  return {
    ...base,
    channel: { type: chat.channelType, kind: chat.kind },
    read: { ok: true },
    intervene: {
      ok: true,
      verifiedBases: await verifiedInterventionBases(
        db,
        supportCase,
        input.now,
      ),
    },
    requiresTargets: requiresTargets(chat),
    parties,
  };
}
