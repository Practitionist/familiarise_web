import { z } from "zod";
import {
  Prisma,
  SupportCaseStatus,
  type UserRole,
  type SupportCase,
} from "@prisma/client";
import { SupportIssueTypeEnum } from "@/schemas/enums";
import { callbackPhoneSchema } from "@/lib/validation/phone";
import { stageBell } from "@/lib/novu/stage-bell";
import { NOVU_WORKFLOWS, notificationScope } from "@/lib/novu/workflows";
import { supportRequestHref } from "@/lib/novu/resolve-href";
import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
  type Tx,
} from "@/lib/prisma";
import { caseKeyOf } from "./case-key";
import { stage as stageEmail } from "@/lib/email/deliver";
import { DEFAULT_FROM_ADDRESS } from "@/lib/email/config";
import {
  canCorrespondOnCase,
  caseCorrespondentIds,
  casePresenterIds,
  caseThreadPartyIds,
  isPresenterOnCase,
  projectCaseForViewer,
} from "./case-access";
import {
  PRESENTER_MESSAGE_METADATA,
  isPresenterAuthoredMessage,
} from "./case-message-actor";
import { REOPEN_WINDOW_MS, supportDeadline } from "./deadline-policy";
import { stageExternalRequesterEmail } from "./external-requester";
import { allocateTicketReference } from "./reference";
import {
  activeHolds,
  caseHoldEvents,
  releaseAllCaseHolds,
  type ReleasedCaseHold,
} from "./case-holds";
import { REAUTH_REQUIRED } from "@/lib/auth/step-up";
import { assertMoneyDoorsOpen } from "@/lib/backoffice/maintenance-gate";
import { recordOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import {
  endCaseChatAccessTx,
  scheduleChatAccessRelease,
} from "./chat-access-end";
import {
  assertCaseTransition,
  caseTransitionRefusal,
} from "./case-transitions";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import {
  openWaitSeconds,
  reopenedClockPatch,
  slaDeadlinesFor,
  tightenDeadlinesForPriorityRaise,
  userRepliedPatch,
} from "./sla";

const IST_OFFSET_MS = 330 * 60_000;
const TWENTY_EIGHT_DAYS_MS = 28 * 24 * 3_600_000;
const TWENTY_FOUR_HOURS_MS = 24 * 3_600_000;

export const CALLBACK_WINDOWS = [
  "09:00-12:00 IST",
  "12:00-15:00 IST",
  "15:00-18:00 IST",
  "18:00-21:00 IST",
] as const;

export const CallbackWindowSchema = z.enum(CALLBACK_WINDOWS);

export class SupportCaseValidationError extends Error {
  readonly status = 400 as const;
  readonly code = "VALIDATION_FAILED" as const;

  constructor(message: string) {
    super(message);
    this.name = "SupportCaseValidationError";
  }
}

const CASE_RELATIONS_INCLUDE = {
  subjects: true,
  messages: { orderBy: { seq: "asc" }, take: -200 },
  events: { orderBy: { createdAt: "asc" } },
} as const;

type SupportCaseWithRelations = Prisma.SupportCaseGetPayload<{
  include: typeof CASE_RELATIONS_INCLUDE;
}>;

function projectStaffCase(
  supportCase: SupportCaseWithRelations,
  viewer: { canReadContact?: boolean; canReadPayments?: boolean },
) {
  return {
    ...supportCase,
    callbackPhone: viewer.canReadContact ? supportCase.callbackPhone : null,
    subjects: supportCase.subjects.filter(
      (subject) =>
        viewer.canReadPayments ||
        !["PAYMENT", "REFUND", "INVOICE"].includes(subject.subjectType),
    ),
    filedByOrganizationNotice: false as const,
    viewerIsPresenter: false as const,
  };
}

export const SupportCaseStatusSchema = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "ESCALATED",
  "RESOLVED",
  "CLOSED",
]);

export const SupportCaseKindSchema = z.enum(["INCIDENT", "PROBLEM"]);

export const SupportSubjectTypeSchema = z.enum([
  "APPOINTMENT",
  "OCCURRENCE",
  "PAYMENT",
  "REFUND",
  "INVOICE",
  "ORGANIZATION",
  "ACCOUNT",
]);

export const SupportPrioritySchema = z.enum([
  "LOW",
  "MEDIUM",
  "HIGH",
  "URGENT",
]);

export const SupportChannelSchema = z.enum(["SELF_SERVE", "HUMAN"]);

export const SupportIssueTypeSchema = SupportIssueTypeEnum;

export const SupportMessageSenderSchema = z.enum([
  "USER",
  "AGENT",
  "BOT",
  "SYSTEM",
]);

export function refineCreateSupportCaseInput<
  T extends {
    category?: string | null;
    flowKey?: string | null;
    appointmentId?: string | null;
    appointmentOccurrenceId?: string | null;
  },
>(data: T, ctx: z.RefinementCtx) {
  if (
    (data.category === undefined || data.category === null) &&
    (data.flowKey === undefined || data.flowKey === null)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["category"],
      message: "Either category or flowKey must be provided.",
    });
  }
  if (
    data.appointmentOccurrenceId !== undefined &&
    data.appointmentOccurrenceId !== null &&
    !data.appointmentId
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["appointmentId"],
      message:
        "appointmentId is required when appointmentOccurrenceId is provided.",
    });
  }
}

export const CreateSupportCaseObjectSchema = z.object({
  initialSender: z.enum(["USER", "AGENT", "SYSTEM"]).optional(),
  initialAuthorUserId: z.string().min(1).max(64).optional(),
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(10_000),
  category: z.string().trim().max(64).nullable().optional(),
  flowKey: z.string().trim().max(64).nullable().optional(),
  currentNodeId: z.string().trim().max(64).nullable().optional(),
  activeChannel: SupportChannelSchema.optional(),
  issueType: SupportIssueTypeSchema.nullable().optional(),
  priority: SupportPrioritySchema.optional(),
  caseKind: SupportCaseKindSchema.optional(),
  problemCaseId: z.string().min(1).max(64).nullable().optional(),
  requesterUserId: z.string().min(1).max(64),
  submitterUserId: z.string().min(1).max(64),
  organizationId: z.string().min(1).max(64).nullable().optional(),
  ownershipScope: z
    .enum(["PERSONAL", "ORG_OPERATIONS", "ORG_BILLING"])
    .optional(),
  appointmentId: z.string().min(1).max(64).nullable().optional(),
  appointmentOccurrenceId: z.string().min(1).max(64).nullable().optional(),
  callbackPhone: callbackPhoneSchema.nullish(),
  callbackWindow: CallbackWindowSchema.nullish(),
  clientIntakeId: z.string().trim().min(1).max(128).nullable().optional(),
  subjects: z
    .array(
      z.object({
        subjectType: SupportSubjectTypeSchema,
        subjectId: z.string().min(1).max(128),
        isPrimary: z.boolean().optional(),
      }),
    )
    .optional(),
});

export const CreateSupportCaseInputSchema =
  CreateSupportCaseObjectSchema.superRefine(refineCreateSupportCaseInput);

export type CreateSupportCaseInput = z.infer<
  typeof CreateSupportCaseInputSchema
>;

export const AppendSupportCaseTurnSchema = z.object({
  caseId: z.string().min(1).max(64),
  authorUserId: z.string().min(1).max(64).nullable().optional(),
  sender: SupportMessageSenderSchema,
  /** A presenter replies as a provider without staff powers or state changes. */
  actorKind: z.enum(["PRESENTER"]).optional(),
  body: z.string().trim().min(1).max(10_000),
  isInternal: z.boolean().default(false),
  clientTurnId: z.string().trim().min(1).max(128).nullable().optional(),
  expectedLastMessageAt: z.string().datetime().optional(),
  /** "This didn't fix it": reopens an undecided, recently resolved case. */
  reopen: z.boolean().optional(),
});

export type AppendSupportCaseTurnInput = z.infer<
  typeof AppendSupportCaseTurnSchema
>;

export const PatchSupportCaseSchema = z.object({
  caseId: z.string().min(1).max(64),
  actorId: z.string().min(1).max(64),
  expectedUpdatedAt: z.string().datetime(),
  status: SupportCaseStatusSchema.optional(),
  priority: SupportPrioritySchema.optional(),
  assignedToId: z.string().min(1).max(64).nullable().optional(),
  problemCaseId: z.string().min(1).max(64).nullable().optional(),
  note: z.string().trim().max(10_000).optional(),
  closingMessage: z.string().trim().max(10_000).optional(),
  /** Admin-only at the route; blocks the post-closure evidence purge. */
  legalHold: z.boolean().optional(),
});

export type PatchSupportCaseInput = z.infer<typeof PatchSupportCaseSchema>;

export const SubmitSupportCaseCsatSchema = z.object({
  caseId: z.string().min(1).max(64),
  userId: z.string().min(1).max(64),
  rating: z.number().int().min(1).max(5),
});

export type SubmitSupportCaseCsatInput = z.infer<
  typeof SubmitSupportCaseCsatSchema
>;

/** The decision now in force on a case: the one no later decision supersedes. */
export function latestCaseDecisionTx(tx: Tx, caseId: string) {
  return tx.supportCaseDecision.findFirst({
    where: { caseId, supersededBy: { is: null } },
    orderBy: { createdAt: "desc" },
  });
}

/** The 409 body for a write refused because the case has a decision. */
export function caseDecidedDetail(decision: { id: string; appealUntil: Date }) {
  return {
    appealUntil: decision.appealUntil.toISOString(),
    decisionId: decision.id,
  };
}

type OpenScopeTuple = Pick<
  SupportCase,
  | "ownershipScope"
  | "organizationId"
  | "scopeKey"
  | "requesterUserId"
  | "submitterUserId"
  | "category"
>;

/**
 * After a unique violation, the other open case holding this open-scope slot
 * as a 409 body, or null when the violation was something else. Reads outside
 * the failed transaction.
 */
export async function openCaseConflict(
  tuple: OpenScopeTuple,
  excludeCaseId: string,
) {
  const existing = await prisma.supportCase.findFirst({
    where: {
      ownershipScope: tuple.ownershipScope,
      organizationId: tuple.organizationId,
      scopeKey: tuple.scopeKey,
      requesterUserId: tuple.requesterUserId,
      submitterUserId: tuple.submitterUserId,
      category: tuple.category,
      closedAt: null,
      deletedAt: null,
      id: { not: excludeCaseId },
    },
    select: { id: true, referenceNumber: true },
  });
  if (!existing) return null;
  return {
    status: 409 as const,
    code: "OPEN_CASE_EXISTS" as const,
    error:
      "There's already an open request about this. Continue in that request instead.",
    existingCase: {
      id: existing.id,
      referenceNumber: existing.referenceNumber,
      caseKey: caseKeyOf({ kind: "case", id: existing.id }),
    },
  };
}

function caseScopeKey(input: CreateSupportCaseInput): string {
  if (input.appointmentOccurrenceId)
    return `OCCURRENCE:${input.appointmentOccurrenceId}`;
  if (input.appointmentId) return `APPOINTMENT:${input.appointmentId}`;
  const primary = input.subjects?.find((subject) => subject.isPrimary);
  return primary ? `${primary.subjectType}:${primary.subjectId}` : "ACCOUNT";
}

function buildInitialCaseSubjects(input: CreateSupportCaseInput) {
  const subjectMap = new Map<
    string,
    {
      subjectType: z.infer<typeof SupportSubjectTypeSchema>;
      subjectId: string;
      isPrimary: boolean;
    }
  >();
  const pushSubject = (
    subjectType: z.infer<typeof SupportSubjectTypeSchema>,
    subjectId: string,
    isPrimary: boolean,
  ) => {
    const key = `${subjectType}:${subjectId}`;
    if (!subjectMap.has(key)) {
      subjectMap.set(key, { subjectType, subjectId, isPrimary });
    }
  };

  if (input.appointmentId) {
    pushSubject(
      "APPOINTMENT",
      input.appointmentId,
      !input.appointmentOccurrenceId,
    );
  }
  if (input.appointmentOccurrenceId) {
    pushSubject("OCCURRENCE", input.appointmentOccurrenceId, true);
  }
  if (input.organizationId) {
    pushSubject("ORGANIZATION", input.organizationId, false);
  }
  for (const s of input.subjects ?? []) {
    pushSubject(s.subjectType, s.subjectId, s.isPrimary ?? false);
  }
  return [...subjectMap.values()];
}

async function appendOpenScopeTurn(
  tx: Tx,
  existingOpen: { id: string },
  input: CreateSupportCaseInput,
  now: Date,
) {
  const result = await executeAppendTurnTx(
    tx,
    {
      caseId: existingOpen.id,
      authorUserId: input.initialAuthorUserId ?? input.submitterUserId,
      sender: input.initialSender ?? "USER",
      body: input.description,
      isInternal: false,
      clientTurnId: input.clientIntakeId,
    },
    now,
  );
  if (!result.ok) throw new SupportCaseValidationError(result.error);
  let refreshed = await tx.supportCase.findUniqueOrThrow({
    where: { id: existingOpen.id },
    include: CASE_RELATIONS_INCLUDE,
  });
  // A decided case only takes follow-ups; an undecided guided answer may still go to a person.
  const handoff =
    input.activeChannel === "HUMAN" &&
    refreshed.activeChannel !== "HUMAN" &&
    !(
      refreshed.status === "RESOLVED" &&
      (await latestCaseDecisionTx(tx, refreshed.id))
    );
  if (handoff) {
    const priority = input.priority ?? refreshed.priority;
    const status = refreshed.assignedToId ? "IN_PROGRESS" : "OPEN";
    assertCaseTransition(refreshed.status, status, {
      decided: false,
      actor: "CUSTOMER",
    });
    const moved = await tx.supportCase.updateMany({
      where: {
        id: refreshed.id,
        updatedAt: refreshed.updatedAt,
        status: refreshed.status,
        activeChannel: refreshed.activeChannel,
        closedAt: null,
      },
      data: {
        activeChannel: "HUMAN",
        status,
        resolvedAt: null,
        priority,
        receivedAt: now,
        ...slaDeadlinesFor(priority, now),
        ...supportDeadline(input.category, now),
      },
    });
    if (!moved.count)
      throw new SupportCaseValidationError(
        "The case changed during handoff. Refresh and retry.",
      );
    const actorId = input.initialAuthorUserId ?? input.submitterUserId;
    if (refreshed.status !== status)
      await tx.supportCaseEvent.create({
        data: {
          caseId: refreshed.id,
          actorId,
          kind: "STATUS_CHANGED",
          fromValue: refreshed.status,
          toValue: status,
          createdAt: now,
        },
      });
    await tx.supportCaseEvent.create({
      data: {
        caseId: refreshed.id,
        actorId,
        kind: "CHANNEL_CHANGED",
        fromValue: refreshed.activeChannel,
        toValue: "HUMAN",
        createdAt: now,
      },
    });
    refreshed = await tx.supportCase.findUniqueOrThrow({
      where: { id: existingOpen.id },
      include: CASE_RELATIONS_INCLUDE,
    });
    await stageSupportCaseIntakeTx(tx, refreshed, input.initialSender);
  }
  return {
    supportCase: refreshed,
    reused: true,
    dedupeReason:
      refreshed.status === "RESOLVED"
        ? ("resolved_case" as const)
        : ("open_scope" as const),
  };
}

async function validateProblemCaseTargetTx(
  tx: Tx,
  problemCaseId: string,
  currentCaseId?: string,
): Promise<boolean> {
  const target = await tx.supportCase.findUnique({
    where: { id: problemCaseId },
    select: { id: true, caseKind: true, deletedAt: true, status: true },
  });
  // A settled problem no longer resolves anything, so a late link would hang.
  return (
    target?.deletedAt === null &&
    target.caseKind === "PROBLEM" &&
    target.status !== "RESOLVED" &&
    target.status !== "CLOSED" &&
    target.id !== currentCaseId
  );
}

async function executeCreateOrReuseCaseTx(
  tx: Tx,
  input: CreateSupportCaseInput,
  now: Date,
) {
  if (input.problemCaseId !== undefined && input.problemCaseId !== null) {
    const validProblem = await validateProblemCaseTargetTx(
      tx,
      input.problemCaseId,
    );
    if (!validProblem) {
      throw new SupportCaseValidationError(
        "problemCaseId must reference an active PROBLEM case.",
      );
    }
  }

  if (input.clientIntakeId) {
    const replayed = await tx.supportCase.findFirst({
      where: {
        clientIntakeId: input.clientIntakeId,
        submitterUserId: input.submitterUserId,
      },
      include: CASE_RELATIONS_INCLUDE,
    });
    if (replayed) {
      return {
        supportCase: replayed,
        reused: true,
        dedupeReason: "client_intake_id" as const,
      };
    }
  }

  const existingOpen = await tx.supportCase.findFirst({
    where: {
      requesterUserId: input.requesterUserId,
      submitterUserId: input.submitterUserId,
      appointmentId: input.appointmentId ?? null,
      appointmentOccurrenceId: input.appointmentOccurrenceId ?? null,
      category: input.category ?? null,
      organizationId: input.organizationId ?? null,
      ownershipScope: input.ownershipScope ?? "PERSONAL",
      scopeKey: caseScopeKey(input),
      closedAt: null,
      deletedAt: null,
    },
    include: CASE_RELATIONS_INCLUDE,
  });
  if (existingOpen) return appendOpenScopeTurn(tx, existingOpen, input, now);

  const priority = input.priority ?? "MEDIUM";
  const referenceNumber = await allocateTicketReference(tx, now);
  const { ackDueAt, resolutionDueAt } =
    input.activeChannel === "HUMAN"
      ? slaDeadlinesFor(priority, now)
      : { ackDueAt: null, resolutionDueAt: null };
  const caseKind = input.caseKind ?? "INCIDENT";
  const problemCaseId =
    caseKind === "PROBLEM" ? null : (input.problemCaseId ?? null);

  const created = await tx.supportCase.create({
    data: {
      referenceNumber,
      clientIntakeId: input.clientIntakeId ?? null,
      ownershipScope: input.ownershipScope ?? "PERSONAL",
      scopeKey: caseScopeKey(input),
      ...(input.activeChannel === "HUMAN"
        ? { ...supportDeadline(input.category, now), receivedAt: now }
        : {}),
      title: input.title,
      description: input.description,
      category: input.category ?? null,
      flowKey: input.flowKey ?? null,
      currentNodeId: input.currentNodeId ?? null,
      activeChannel: input.activeChannel ?? "SELF_SERVE",
      issueType: input.issueType ?? null,
      priority,
      status: input.initialSender === "AGENT" ? "IN_PROGRESS" : "OPEN",
      ...(input.initialSender === "AGENT"
        ? {
            assignedToId: input.initialAuthorUserId,
            acknowledgedAt: now,
            firstAgentReplyAt: now,
            awaitingUserSince: now,
          }
        : {}),
      caseKind,
      problemCaseId,
      requesterUserId: input.requesterUserId,
      submitterUserId: input.submitterUserId,
      organizationId: input.organizationId ?? null,
      appointmentId: input.appointmentId ?? null,
      appointmentOccurrenceId: input.appointmentOccurrenceId ?? null,
      callbackPhone: input.callbackPhone ?? null,
      callbackWindow: input.callbackWindow ?? null,
      ackDueAt,
      resolutionDueAt,
      messageSeq: 1,
      lastMessageAt: now,
      subjects: {
        create: buildInitialCaseSubjects(input),
      },
      messages: {
        create: [
          {
            seq: 1,
            sender: input.initialSender ?? "USER",
            body: input.description,
            isInternal: false,
            clientTurnId: input.clientIntakeId ?? null,
            authorUserId:
              input.initialSender === "SYSTEM"
                ? null
                : (input.initialAuthorUserId ?? input.submitterUserId),
            createdAt: now,
          },
        ],
      },
      events: {
        create: [
          {
            actorId: input.submitterUserId,
            kind: "CREATED",
            toValue: "OPEN",
            createdAt: now,
          },
        ],
      },
    },
    include: CASE_RELATIONS_INCLUDE,
  });

  await stageSupportCaseIntakeTx(tx, created, input.initialSender);
  return {
    supportCase: created,
    reused: false,
    dedupeReason: null,
  };
}

/** Stage formal intake notifications in the same transaction as its first human handoff. */
export async function stageSupportCaseIntakeTx(
  tx: Tx,
  created: Pick<
    SupportCase,
    | "id"
    | "referenceNumber"
    | "title"
    | "description"
    | "activeChannel"
    | "submitterUserId"
    | "organizationId"
    | "ownershipScope"
    | "externalRequesterEmail"
    | "appointmentId"
    | "category"
    | "issueType"
  >,
  initialSender?: "USER" | "AGENT" | "SYSTEM",
) {
  if (created.activeChannel === "HUMAN") {
    const operators = await tx.user.findMany({
      where: { role: { in: ["STAFF", "ADMIN"] }, banned: false },
      select: { id: true },
    });
    const href = supportRequestHref(
      caseKeyOf({ kind: "case", id: created.id }),
      created.organizationId,
    );
    await stageBell(tx, {
      workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_CREATED,
      recipients: operators.map((operator) => operator.id),
      dedupeKey: `case-created:${created.id}:staff`,
      entityRef: `case-created:${created.id}`,
      payload: {
        ticketId: created.id,
        reference: created.referenceNumber,
        ticketTitle: created.title,
        dashboardUrl: href,
        ...notificationScope(created.organizationId),
      },
    });
    if (initialSender !== "SYSTEM") {
      const threadPartyIds = await caseThreadPartyIds(created, tx);
      await stageBell(tx, {
        workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE,
        recipients: threadPartyIds,
        dedupeKey: `case-created:${created.id}:customer`,
        entityRef: `case-created:${created.id}`,
        payload: {
          ticketId: created.id,
          reference: created.referenceNumber,
          ticketTitle: created.title,
          status:
            initialSender === "AGENT"
              ? "New support message"
              : "Request received",
          dashboardUrl: href,
          ...notificationScope(created.organizationId),
        },
      });
      const recipients = await tx.user.findMany({
        where: { id: { in: threadPartyIds } },
        select: { email: true },
      });
      // Keep outbox writes sequential on the transaction’s single connection.
      for (const recipient of recipients) {
        const text = `Reference: ${created.referenceNumber}\n\n${created.ownershipScope === "PERSONAL" ? created.description : "An organization support case was received."}\n\n${href}`;
        const html = text
          .replace(
            /[&<>"']/g,
            (character) =>
              ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
              })[character] ?? character,
          )
          .replace(/\n/g, "<br>");
        await stageEmail(
          {
            from: DEFAULT_FROM_ADDRESS,
            to: recipient.email,
            subject: `Support case — ${created.referenceNumber}`,
            html,
            text,
          },
          "SUPPORT_TICKET_RECEIVED",
          { tx, entityRef: `case-created:${created.id}` },
        );
      }
    }
  }
}

async function recoverFromCaseUniqueConflict(input: CreateSupportCaseInput) {
  if (input.clientIntakeId) {
    const winningIntake = await prisma.supportCase.findFirst({
      where: {
        clientIntakeId: input.clientIntakeId,
        submitterUserId: input.submitterUserId,
      },
      include: CASE_RELATIONS_INCLUDE,
    });
    if (winningIntake) {
      return {
        supportCase: winningIntake,
        reused: true,
        dedupeReason: "client_intake_id" as const,
      };
    }
  }

  const winningOpen = await prisma.supportCase.findFirst({
    where: {
      requesterUserId: input.requesterUserId,
      submitterUserId: input.submitterUserId,
      appointmentId: input.appointmentId ?? null,
      appointmentOccurrenceId: input.appointmentOccurrenceId ?? null,
      category: input.category ?? null,
      organizationId: input.organizationId ?? null,
      ownershipScope: input.ownershipScope ?? "PERSONAL",
      scopeKey: caseScopeKey(input),
      closedAt: null,
      deletedAt: null,
    },
    include: CASE_RELATIONS_INCLUDE,
  });
  if (winningOpen) {
    return {
      supportCase: winningOpen,
      reused: true,
      dedupeReason: "open_scope" as const,
    };
  }

  return null;
}

/** Create a unified support case or return an existing match via clientIntakeId or open-scope dedupe. */
export async function createOrReuseSupportCase(
  rawInput: CreateSupportCaseInput,
  now: Date = new Date(),
) {
  const input = CreateSupportCaseInputSchema.parse(rawInput);

  try {
    return await prisma.$transaction(
      (tx) => executeCreateOrReuseCaseTx(tx, input, now),
      {
        maxWait: ALLOCATION_TX_MAX_WAIT_MS,
        timeout: ALLOCATION_TX_TIMEOUT_MS,
      },
    );
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const recovered = await recoverFromCaseUniqueConflict(input);
      if (recovered?.dedupeReason === "open_scope")
        return prisma.$transaction((tx) =>
          appendOpenScopeTurn(tx, { id: recovered.supportCase.id }, input, now),
        );
      if (recovered) return recovered;
    }
    throw err;
  }
}

async function replayClientTurnIfExists(
  tx: Tx,
  input: AppendSupportCaseTurnInput,
) {
  if (!input.clientTurnId) return null;
  const existingTurn = await tx.supportCaseMessage.findUnique({
    where: {
      caseId_clientTurnId: {
        caseId: input.caseId,
        clientTurnId: input.clientTurnId,
      },
    },
    select: { seq: true },
  });
  if (!existingTurn) return null;

  const subsequent = await tx.supportCaseMessage.findMany({
    where: {
      caseId: input.caseId,
      seq: { gte: existingTurn.seq },
      ...(input.sender !== "AGENT" || input.actorKind === "PRESENTER"
        ? { isInternal: false }
        : {}),
    },
    orderBy: { seq: "asc" },
    take: 200,
  });
  return {
    ok: true as const,
    replayed: true,
    messages: subsequent,
  };
}

async function advanceUserTurnState(
  tx: Tx,
  existingCase: NonNullable<
    Awaited<ReturnType<typeof prisma.supportCase.findUnique>>
  >,
  input: AppendSupportCaseTurnInput,
  reopening: boolean,
  now: Date,
): Promise<boolean> {
  // A reply is a follow-up; only an explicit reopen moves a resolved case.
  const nextStatus = existingCase.assignedToId ? "IN_PROGRESS" : "OPEN";
  const moved = await tx.supportCase.updateMany({
    where: {
      id: input.caseId,
      status: existingCase.status,
      awaitingUserSince: existingCase.awaitingUserSince,
      pausedSeconds: existingCase.pausedSeconds,
      // A reopen dates its new deadline from the priority it read.
      ...(reopening
        ? {
            resolvedAt: existingCase.resolvedAt,
            priority: existingCase.priority,
          }
        : {}),
    },
    data: {
      messageSeq: { increment: 1 },
      lastMessageAt: now,
      ...(reopening ? { status: nextStatus, resolvedAt: null } : {}),
      ...userRepliedPatch(existingCase, now),
      ...(reopening
        ? reopenedClockPatch(existingCase, existingCase.priority, now)
        : {}),
    },
  });
  if ((moved?.count ?? 0) === 0) return false;

  if (reopening) {
    await tx.supportCaseEvent.create({
      data: {
        caseId: input.caseId,
        actorId: input.authorUserId ?? null,
        kind: "REOPENED",
        fromValue: existingCase.status,
        toValue: nextStatus,
        createdAt: now,
      },
    });
  }
  return true;
}

async function advanceAgentPublicTurnState(
  tx: Tx,
  existingCase: NonNullable<
    Awaited<ReturnType<typeof prisma.supportCase.findUnique>>
  >,
  input: AppendSupportCaseTurnInput,
  now: Date,
): Promise<boolean> {
  const waitDelta = openWaitSeconds(existingCase, now);
  const openTransitionPatch =
    existingCase.status === "OPEN"
      ? {
          status: "IN_PROGRESS" as const,
          assignedToId: existingCase.assignedToId ?? input.authorUserId ?? null,
        }
      : {};
  const expectedDate = input.expectedLastMessageAt
    ? new Date(input.expectedLastMessageAt)
    : undefined;

  const moved = await tx.supportCase.updateMany({
    where: {
      id: input.caseId,
      status: existingCase.status,
      updatedAt: existingCase.updatedAt,
      awaitingUserSince: existingCase.awaitingUserSince,
      ...(expectedDate
        ? {
            OR: [
              { lastMessageAt: null },
              { lastMessageAt: { lte: expectedDate } },
            ],
          }
        : {}),
    },
    data: {
      messageSeq: { increment: 1 },
      lastMessageAt: now,
      acknowledgedAt: existingCase.acknowledgedAt ?? now,
      firstAgentReplyAt: existingCase.firstAgentReplyAt ?? now,
      awaitingUserSince: now,
      pausedSeconds: existingCase.pausedSeconds + waitDelta,
      ...openTransitionPatch,
    },
  });
  return (moved?.count ?? 0) > 0;
}

async function applyTurnStateUpdate(
  tx: Tx,
  existingCase: NonNullable<
    Awaited<ReturnType<Tx["supportCase"]["findUnique"]>>
  >,
  input: AppendSupportCaseTurnInput,
  reopening: boolean,
  now: Date,
): Promise<boolean> {
  if (input.actorKind === "PRESENTER") {
    await tx.supportCase.updateMany({
      where: { id: input.caseId },
      data: { messageSeq: { increment: 1 }, lastMessageAt: now },
    });
    return true;
  }
  if (input.sender === "USER") {
    return advanceUserTurnState(tx, existingCase, input, reopening, now);
  }
  if (input.sender === "AGENT" && !input.isInternal) {
    return advanceAgentPublicTurnState(tx, existingCase, input, now);
  }
  await tx.supportCase.updateMany({
    where: { id: input.caseId },
    data: {
      messageSeq: { increment: 1 },
      ...(input.isInternal ? {} : { lastMessageAt: now }),
    },
  });
  return true;
}

interface CaseTurnFanout {
  bell: string[];
  email: string[];
  emailSubject: string;
}

async function caseTurnFanoutTx(
  tx: Tx,
  existingCase: SupportCase,
  input: AppendSupportCaseTurnInput,
): Promise<CaseTurnFanout> {
  const presenters = await casePresenterIds(existingCase, tx);
  const assignee = existingCase.assignedToId ? [existingCase.assignedToId] : [];
  if (input.actorKind === "PRESENTER") {
    const correspondents = await caseCorrespondentIds(existingCase, tx);
    return {
      bell: [...new Set([...correspondents, ...presenters, ...assignee])],
      // The assignee watches the queue but is not a customer correspondent.
      email: correspondents,
      emailSubject: `New presenter reply — ${existingCase.referenceNumber}`,
    };
  }
  if (input.sender === "AGENT") {
    const correspondents = await caseCorrespondentIds(existingCase, tx);
    return {
      bell: [...new Set([...correspondents, ...presenters, ...assignee])],
      email: [...new Set([...correspondents, ...presenters])],
      emailSubject: `Support response — ${existingCase.referenceNumber}`,
    };
  }
  const staffIds = existingCase.assignedToId
    ? [existingCase.assignedToId]
    : (
        await tx.user.findMany({
          where: { role: { in: ["STAFF", "ADMIN"] }, banned: false },
          select: { id: true },
        })
      ).map((operator) => operator.id);
  return {
    bell: [...new Set([...staffIds, ...presenters])],
    email: presenters,
    emailSubject: `Support response — ${existingCase.referenceNumber}`,
  };
}

async function stageCaseResponseEmailsTx(
  tx: Tx,
  existingCase: SupportCase,
  body: string,
  recipients: string[],
  messageId: string,
  subject: string,
): Promise<void> {
  const customers = await tx.user.findMany({
    where: { id: { in: recipients } },
    select: { email: true },
  });
  const href = supportRequestHref(
    caseKeyOf({ kind: "case", id: existingCase.id }),
    existingCase.organizationId,
  );
  const text = `Reference: ${existingCase.referenceNumber}\n\n${existingCase.ownershipScope === "PERSONAL" ? body : "A new response is available in your organization support workspace."}\n\n${href}`;
  const html = text
    .replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character] ?? character,
    )
    .replace(/\n/g, "<br>");
  // Keep outbox writes sequential on the transaction’s single connection.
  for (const customer of customers)
    await stageEmail(
      {
        from: DEFAULT_FROM_ADDRESS,
        to: customer.email,
        subject,
        html,
        text,
      },
      "SUPPORT_TICKET_RESPONSE",
      { tx, entityRef: `case-message:${messageId}` },
    );
}

async function stageCaseTurnNotificationsTx(
  tx: Tx,
  existingCase: SupportCase,
  input: AppendSupportCaseTurnInput,
  messageId: string,
): Promise<void> {
  if (input.isInternal || (input.sender !== "USER" && input.sender !== "AGENT"))
    return;
  if (
    input.sender === "AGENT" &&
    input.actorKind !== "PRESENTER" &&
    existingCase.externalRequesterEmail
  ) {
    await stageExternalRequesterEmail(
      {
        caseId: existingCase.id,
        reference: existingCase.referenceNumber,
        to: existingCase.externalRequesterEmail,
        subject: `Support response — ${existingCase.referenceNumber}`,
        text: `${input.body}\n\nReference: ${existingCase.referenceNumber}`,
        emailType: "SUPPORT_TICKET_RESPONSE",
        entityRef: `case-message:${messageId}`,
      },
      tx,
    );
    return;
  }
  const fanout = await caseTurnFanoutTx(tx, existingCase, input);
  const recipients = fanout.bell.filter(
    (recipientId) => recipientId !== input.authorUserId,
  );
  await stageBell(tx, {
    workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE,
    recipients,
    dedupeKey: `case-message:${messageId}`,
    entityRef: `case-message:${messageId}`,
    payload: {
      ticketId: existingCase.id,
      reference: existingCase.referenceNumber,
      ticketTitle: existingCase.title,
      status: "New response",
      dashboardUrl: supportRequestHref(
        caseKeyOf({ kind: "case", id: existingCase.id }),
        existingCase.organizationId,
      ),
      ...notificationScope(existingCase.organizationId),
    },
  });
  const emailRecipients = fanout.email.filter(
    (recipientId) => recipientId !== input.authorUserId,
  );
  if (emailRecipients.length)
    await stageCaseResponseEmailsTx(
      tx,
      existingCase,
      input.body,
      emailRecipients,
      messageId,
      fanout.emailSubject,
    );
}

async function appendTurnConflictTx(
  tx: Tx,
  existingCase: Pick<SupportCase, "lastMessageAt">,
  input: AppendSupportCaseTurnInput,
) {
  if (
    input.sender === "AGENT" &&
    !input.isInternal &&
    input.expectedLastMessageAt
  ) {
    const expectedDate = new Date(input.expectedLastMessageAt);
    const latestRow = await tx.supportCase.findUnique({
      where: { id: input.caseId },
      select: { lastMessageAt: true },
    });
    const latestLastMessageAt =
      latestRow?.lastMessageAt ?? existingCase.lastMessageAt;
    if (
      latestLastMessageAt &&
      latestLastMessageAt.getTime() > expectedDate.getTime()
    ) {
      return {
        ok: false as const,
        status: 409 as const,
        code: "NEW_CUSTOMER_MESSAGE" as const,
        error:
          "Customer replied since you opened this case. Review their message before sending.",
      };
    }
  }
  return {
    ok: false as const,
    status: 409 as const,
    code: "CONFLICT" as const,
    error: "Support case was updated concurrently.",
  };
}

/** Why "This didn't fix it" cannot reopen this resolved case, or null when it may. */
async function reopenRefusalTx(
  tx: Tx,
  existingCase: SupportCase,
  input: AppendSupportCaseTurnInput,
  now: Date,
) {
  if (
    input.authorUserId !== existingCase.requesterUserId &&
    input.authorUserId !== existingCase.submitterUserId
  )
    return {
      ok: false as const,
      status: 403 as const,
      code: "REOPEN_NOT_ALLOWED" as const,
      error: "Only the person who raised this request can reopen it.",
    };
  const decision = await latestCaseDecisionTx(tx, existingCase.id);
  const nextStatus = existingCase.assignedToId ? "IN_PROGRESS" : "OPEN";
  const refusal = caseTransitionRefusal("RESOLVED", nextStatus, {
    decided: decision !== null,
    actor: "CUSTOMER",
  });
  if (refusal)
    return {
      ok: false as const,
      ...refusal,
      ...(decision ? caseDecidedDetail(decision) : {}),
    };
  if (
    !existingCase.resolvedAt ||
    now.getTime() - existingCase.resolvedAt.getTime() > REOPEN_WINDOW_MS
  )
    return {
      ok: false as const,
      status: 409 as const,
      code: "REOPEN_WINDOW_EXPIRED" as const,
      error:
        "This support case was resolved more than 14 days ago. Start a new support case if you still need help.",
    };
  return null;
}

async function presenterTurnRefusalTx(
  tx: Tx,
  existingCase: SupportCase,
  input: AppendSupportCaseTurnInput,
) {
  if (input.actorKind !== "PRESENTER") return null;
  if (
    input.sender !== "AGENT" ||
    input.isInternal ||
    !input.authorUserId ||
    !(await isPresenterOnCase(existingCase, input.authorUserId, tx))
  )
    return {
      ok: false as const,
      status: 403 as const,
      code: "FORBIDDEN" as const,
      error: "Only an accepted presenter on this booking may reply.",
    };
  return null;
}

async function executeAppendTurnTx(
  tx: Tx,
  input: AppendSupportCaseTurnInput,
  now: Date,
) {
  const replayed = await replayClientTurnIfExists(tx, input);
  if (replayed) return replayed;

  const existingCase = await tx.supportCase.findUnique({
    where: { id: input.caseId },
  });
  if (!existingCase) {
    return {
      ok: false as const,
      status: 404 as const,
      code: "NOT_FOUND" as const,
      error: "Support case not found.",
    };
  }

  if (existingCase.status === "CLOSED" && !input.isInternal) {
    return {
      ok: false as const,
      status: 400 as const,
      code: "CASE_CLOSED" as const,
      error: "Cannot send a public message on a closed case.",
    };
  }

  const presenterRefused = await presenterTurnRefusalTx(
    tx,
    existingCase,
    input,
  );
  if (presenterRefused) return presenterRefused;

  const reopening =
    input.sender === "USER" &&
    input.reopen === true &&
    existingCase.status === "RESOLVED";
  if (reopening) {
    const refused = await reopenRefusalTx(tx, existingCase, input, now);
    if (refused) return refused;
  }

  const applied = await applyTurnStateUpdate(
    tx,
    existingCase,
    input,
    reopening,
    now,
  );
  if (!applied) return appendTurnConflictTx(tx, existingCase, input);

  const seqHolder = await tx.supportCase.findUniqueOrThrow({
    where: { id: input.caseId },
    select: { messageSeq: true },
  });

  const created = await tx.supportCaseMessage.create({
    data: {
      caseId: input.caseId,
      seq: seqHolder.messageSeq,
      sender: input.sender,
      body: input.body,
      isInternal: input.isInternal,
      clientTurnId: input.clientTurnId ?? null,
      authorUserId: input.authorUserId ?? null,
      metadata:
        input.actorKind === "PRESENTER"
          ? PRESENTER_MESSAGE_METADATA
          : undefined,
      createdAt: now,
    },
  });

  await stageCaseTurnNotificationsTx(tx, existingCase, input, created.id);
  return {
    ok: true as const,
    replayed: false,
    messages: [created],
  };
}

/** Append a message turn idempotently via clientTurnId and advance SLA/status via CAS. */
export async function appendSupportCaseTurn(
  rawInput: AppendSupportCaseTurnInput,
  now: Date = new Date(),
) {
  const input = AppendSupportCaseTurnSchema.parse(rawInput);

  try {
    return await prisma.$transaction(
      (tx) => executeAppendTurnTx(tx, input, now),
      {
        maxWait: ALLOCATION_TX_MAX_WAIT_MS,
        timeout: ALLOCATION_TX_TIMEOUT_MS,
      },
    );
  } catch (error) {
    if (
      input.clientTurnId &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const replay = await prisma.$transaction((tx) =>
        replayClientTurnIfExists(tx, input),
      );
      if (replay) return replay;
    }
    throw error;
  }
}

function buildStatusDatesPatch(
  status: z.infer<typeof SupportCaseStatusSchema> | undefined,
  existing: {
    resolvedAt: Date | null;
    awaitingUserSince: Date | null;
    pausedSeconds: number;
  },
  now: Date,
): {
  resolvedAt?: Date | null;
  closedAt?: Date | null;
  awaitingUserSince?: null;
  pausedSeconds?: number;
} {
  if (!status) return {};
  const bankedPause =
    existing.awaitingUserSince !== null ? userRepliedPatch(existing, now) : {};
  if (status === "RESOLVED") {
    return { resolvedAt: now, closedAt: null, ...bankedPause };
  }
  if (status === "CLOSED") {
    return {
      closedAt: now,
      resolvedAt: existing.resolvedAt ?? now,
      ...bankedPause,
    };
  }
  return { resolvedAt: null, closedAt: null, ...bankedPause };
}

type LifecycleAuditBefore = {
  status: z.infer<typeof SupportCaseStatusSchema>;
  priority: z.infer<typeof SupportPrioritySchema>;
  assignedToId: string | null;
  caseKind: z.infer<typeof SupportCaseKindSchema>;
  problemCaseId: string | null;
  legalHoldAt: Date | null;
};
type AuditRow = Prisma.SupportCaseEventCreateManyInput;

function statusAuditRow(
  input: PatchSupportCaseInput,
  existing: LifecycleAuditBefore,
  now: Date,
): AuditRow | null {
  if (!input.status || input.status === existing.status) return null;
  const wasSettled =
    existing.status === "RESOLVED" || existing.status === "CLOSED";
  const isActiveTarget =
    input.status === "OPEN" || input.status === "IN_PROGRESS";
  return {
    caseId: input.caseId,
    actorId: input.actorId,
    kind: wasSettled && isActiveTarget ? "REOPENED" : "STATUS_CHANGED",
    fromValue: existing.status,
    toValue: input.status,
    // The problem-resolution job reads this note as the linked incidents' closing message.
    note:
      input.status === "RESOLVED" ? input.closingMessage?.trim() || null : null,
    createdAt: now,
  };
}

function legalHoldAuditRow(
  input: PatchSupportCaseInput,
  existing: LifecycleAuditBefore,
  noteTrimmed: string | null,
  now: Date,
): AuditRow | null {
  if (!legalHoldChanges(input, existing)) return null;
  return {
    caseId: input.caseId,
    actorId: input.actorId,
    kind: "LEGAL_HOLD_CHANGED",
    fromValue: existing.legalHoldAt ? "ON" : "OFF",
    toValue: input.legalHold ? "ON" : "OFF",
    note: noteTrimmed,
    createdAt: now,
  };
}

/** Priority, assignee and problem-link rows, in that order. */
function routingAuditRows(
  input: PatchSupportCaseInput,
  existing: LifecycleAuditBefore,
  noteTrimmed: string | null,
  now: Date,
): AuditRow[] {
  const rows: AuditRow[] = [];
  if (input.priority && input.priority !== existing.priority)
    rows.push({
      caseId: input.caseId,
      actorId: input.actorId,
      kind: "PRIORITY_CHANGED",
      fromValue: existing.priority,
      toValue: input.priority,
      createdAt: now,
    });
  if (
    input.assignedToId !== undefined &&
    input.assignedToId !== existing.assignedToId
  )
    rows.push({
      caseId: input.caseId,
      actorId: input.actorId,
      kind: input.assignedToId ? "ASSIGNED" : "UNASSIGNED",
      fromValue: existing.assignedToId,
      toValue: input.assignedToId,
      note: noteTrimmed,
      createdAt: now,
    });
  if (
    input.problemCaseId !== undefined &&
    existing.caseKind === "INCIDENT" &&
    input.problemCaseId !== existing.problemCaseId
  )
    rows.push({
      caseId: input.caseId,
      actorId: input.actorId,
      kind: "LINKED_PROBLEM",
      fromValue: existing.problemCaseId,
      toValue: input.problemCaseId,
      createdAt: now,
    });
  return rows;
}

async function recordLifecycleAuditEvents(
  tx: Tx,
  input: PatchSupportCaseInput,
  existing: LifecycleAuditBefore,
  noteTrimmed: string | null,
  now: Date,
): Promise<void> {
  const auditRows = [
    statusAuditRow(input, existing, now),
    legalHoldAuditRow(input, existing, noteTrimmed, now),
    ...routingAuditRows(input, existing, noteTrimmed, now),
  ].filter((row): row is AuditRow => row !== null);

  async function stepAudit(index: number): Promise<void> {
    if (index >= auditRows.length) return;
    await tx.supportCaseEvent.create({ data: auditRows[index] });
    return stepAudit(index + 1);
  }
  await stepAudit(0);
}

function legalHoldChanges(
  input: Pick<PatchSupportCaseInput, "legalHold">,
  existing: { legalHoldAt: Date | null },
): boolean {
  return (
    input.legalHold !== undefined &&
    input.legalHold !== Boolean(existing.legalHoldAt)
  );
}

async function validateOperatorAssigneeTx(
  tx: Tx,
  assignedToId: string | null | undefined,
): Promise<boolean> {
  if (assignedToId === undefined || assignedToId === null) return true;
  const user = await tx.user.findUnique({
    where: { id: assignedToId },
    select: { role: true },
  });
  return Boolean(user && (user.role === "STAFF" || user.role === "ADMIN"));
}

export async function stageCaseResolutionCsatPromptTx(
  tx: Tx,
  target: {
    id: string;
    referenceNumber?: string;
    title?: string;
    submitterUserId?: string;
    requesterUserId?: string;
    externalRequesterEmail?: string | null;
    organizationId?: string | null;
  },
  resolvedAt: Date,
): Promise<void> {
  if (target.externalRequesterEmail) return;
  const current = await tx.supportCase.findUnique({ where: { id: target.id } });
  if (!current) return;
  const recipients = await caseCorrespondentIds(current, tx);
  const dedupeKey = `csat:${target.id}:${resolvedAt.toISOString()}`;
  const bellArgs = {
    workflowId: NOVU_WORKFLOWS.SUPPORT_TICKET_UPDATE,
    recipients,
    payload: {
      ticketId: target.id,
      reference: target.referenceNumber,
      ticketTitle: target.title ?? "Support case",
      status: "Resolved — rate your resolution",
      statusCode: "RESOLVED",
      dashboardUrl: supportRequestHref(
        caseKeyOf({ kind: "case", id: target.id }),
        target.organizationId,
      ),
      ...notificationScope(target.organizationId),
    },
    dedupeKey,
    entityRef: dedupeKey,
    notBefore: new Date(resolvedAt.getTime() + TWENTY_FOUR_HOURS_MS),
  };
  await stageBell(tx, bellArgs);
}

function buildLifecycleUpdateData(
  existing: NonNullable<Awaited<ReturnType<Tx["supportCase"]["findUnique"]>>>,
  input: PatchSupportCaseInput,
  noteTrimmed: string | null,
  now: Date,
): Prisma.SupportCaseUpdateManyMutationInput {
  const tightened =
    input.priority && input.priority !== existing.priority
      ? tightenDeadlinesForPriorityRaise(existing, input.priority, now)
      : {};
  return {
    ...(input.status ? { status: input.status } : {}),
    ...buildStatusDatesPatch(input.status, existing, now),
    ...(input.priority ? { priority: input.priority } : {}),
    ...tightened,
    ...(input.assignedToId !== undefined
      ? { assignedToId: input.assignedToId }
      : {}),
    ...(input.problemCaseId !== undefined && existing.caseKind === "INCIDENT"
      ? { problemCaseId: input.problemCaseId }
      : {}),
    ...(legalHoldChanges(input, existing)
      ? { legalHoldAt: input.legalHold ? now : null }
      : {}),
    ...(noteTrimmed ? { messageSeq: { increment: 1 } } : {}),
    ...(input.status && input.status !== "RESOLVED" && input.status !== "CLOSED"
      ? reopenedClockPatch(existing, input.priority ?? existing.priority, now)
      : {}),
  };
}

/** A legal hold, with an optional reason, is the only change a closed case takes without reopening. */
function isLegalHoldOnlyPatch(input: PatchSupportCaseInput): boolean {
  return (
    input.legalHold !== undefined &&
    !input.status &&
    input.priority === undefined &&
    input.assignedToId === undefined &&
    input.problemCaseId === undefined
  );
}

async function validatePatchLifecyclePreconditionsTx(
  tx: Tx,
  input: PatchSupportCaseInput,
  existing: { id: string; status: SupportCaseStatus },
) {
  if (
    existing.status === "CLOSED" &&
    !input.status &&
    !isLegalHoldOnlyPatch(input)
  ) {
    return {
      ok: false as const,
      status: 400 as const,
      code: "CASE_CLOSED" as const,
      error:
        "This case is closed, so assignee and priority cannot change until it is reopened.",
    };
  }

  if (input.problemCaseId !== undefined && input.problemCaseId !== null) {
    const validProblem = await validateProblemCaseTargetTx(
      tx,
      input.problemCaseId,
      existing.id,
    );
    if (!validProblem) {
      return {
        ok: false as const,
        status: 400 as const,
        code: "VALIDATION_FAILED" as const,
        error:
          "problemCaseId must reference another PROBLEM case that is not yet resolved.",
      };
    }
  }

  if (!(await validateOperatorAssigneeTx(tx, input.assignedToId))) {
    return {
      ok: false as const,
      status: 400 as const,
      code: "VALIDATION_FAILED" as const,
      error: "Assignee must be a staff or admin operator.",
    };
  }

  return null;
}

async function hasConflictingAppealReviewerTx(
  tx: Tx,
  existing: Pick<
    SupportCase,
    "appealOfDecisionId" | "appealOfModerationActionId"
  >,
  input: Pick<PatchSupportCaseInput, "actorId" | "assignedToId">,
): Promise<boolean> {
  if (!existing.appealOfDecisionId && !existing.appealOfModerationActionId)
    return false;
  const reviewerIds = new Set(
    [input.actorId, input.assignedToId].filter((id): id is string =>
      Boolean(id),
    ),
  );
  const decision = existing.appealOfDecisionId
    ? await tx.supportCaseDecision.findUnique({
        where: { id: existing.appealOfDecisionId },
        select: { decidedById: true },
      })
    : null;
  const action = existing.appealOfModerationActionId
    ? await tx.moderationAction.findUnique({
        where: { id: existing.appealOfModerationActionId },
        select: { takenById: true },
      })
    : null;
  return Boolean(
    (decision?.decidedById && reviewerIds.has(decision.decidedById)) ||
    (action?.takenById && reviewerIds.has(action.takenById)),
  );
}

/** The mover of a lifecycle change that may release payout holds: their role and step-up freshness. */
export interface HoldReleaseGrant {
  actorRole: string;
  freshSession: boolean;
}

/** An undecided, unvoided refund recommendation on the case, if any. */
export function openRecommendationTx(tx: Tx, caseId: string) {
  return tx.supportFinancialRecommendation.findFirst({
    where: { caseId, decidedAt: null, voidedAt: null },
    select: { id: true },
  });
}

/** The money doors' maintenance gate as a lifecycle refusal; null while open. */
export async function moneyDoorsRefusal() {
  try {
    await assertMoneyDoorsOpen();
    return null;
  } catch (error) {
    if (!(error instanceof OpsRefusal)) throw error;
    return {
      ok: false as const,
      status: error.httpStatus,
      code: error.code,
      error: error.message,
    };
  }
}

/** One audit row for the payout holds a lifecycle move released. */
export async function recordLifecycleHoldReleaseTx(
  tx: Tx,
  input: {
    caseId: string;
    actorId: string | null;
    actorRole: string;
    status: SupportCaseStatus;
    reason: string;
    released: ReleasedCaseHold[];
  },
) {
  if (input.released.length === 0) return;
  await recordOpsAction(tx, {
    actorUserId: input.actorId,
    actorRole: input.actorRole,
    surface: "tickets.manage",
    action: "support.case.release-holds",
    targetKind: "SupportCase",
    targetId: input.caseId,
    reason: input.reason,
    after: {
      caseId: input.caseId,
      status: input.status,
      holds: input.released.map((hold) => ({ ...hold })),
    },
    correlationId: `support-case:${input.caseId}`,
  });
}

/**
 * Moving into RESOLVED or CLOSED releases the case's payout holds, and resolving
 * a problem lets the cascade release its open incidents' holds, so either needs
 * step-up and open money doors; the case's own holds also need no open recommendation.
 */
async function holdReleaseRefusalTx(
  tx: Tx,
  input: PatchSupportCaseInput,
  existing: Pick<SupportCase, "id" | "status" | "caseKind">,
  grant: HoldReleaseGrant | undefined,
) {
  if (
    (input.status !== "RESOLVED" && input.status !== "CLOSED") ||
    input.status === existing.status
  )
    return null;
  const incidents =
    existing.caseKind === "PROBLEM" && input.status === "RESOLVED"
      ? await tx.supportCase.findMany({
          where: {
            problemCaseId: existing.id,
            caseKind: "INCIDENT",
            status: { notIn: ["RESOLVED", "CLOSED"] },
            deletedAt: null,
          },
          select: { id: true },
        })
      : [];
  const own = activeHolds(await caseHoldEvents(tx, [existing.id]));
  const linked = incidents.length
    ? activeHolds(
        await caseHoldEvents(
          tx,
          incidents.map((incident) => incident.id),
        ),
      )
    : [];
  if (own.length === 0 && linked.length === 0) return null;
  if (own.length > 0 && (await openRecommendationTx(tx, existing.id)))
    return {
      ok: false as const,
      status: 409 as const,
      code: "RECOMMENDATION_OPEN" as const,
      error:
        "This case has a refund recommendation awaiting review. Review or void it before releasing its payout holds.",
    };
  if (!grant?.freshSession)
    return {
      ok: false as const,
      status: 403 as const,
      code: REAUTH_REQUIRED,
      error: "Confirm it's you to release this case's payout holds.",
    };
  return moneyDoorsRefusal();
}

export async function executePatchLifecycleTx(
  tx: Tx,
  input: PatchSupportCaseInput,
  now: Date,
  grant?: HoldReleaseGrant,
) {
  const existing = await tx.supportCase.findUnique({
    where: { id: input.caseId },
  });
  if (!existing) {
    return {
      ok: false as const,
      status: 404 as const,
      code: "NOT_FOUND" as const,
      error: "Support case not found.",
    };
  }

  if (await hasConflictingAppealReviewerTx(tx, existing, input))
    return {
      ok: false as const,
      status: 403 as const,
      code: "INDEPENDENT_REVIEW_REQUIRED" as const,
      error: "A different eligible reviewer must handle this appeal.",
    };

  const preconditionFailure = await validatePatchLifecyclePreconditionsTx(
    tx,
    input,
    existing,
  );
  if (preconditionFailure) return preconditionFailure;
  const transitionFailure = await patchTransitionRefusalTx(tx, input, existing);
  if (transitionFailure) return transitionFailure;
  const holdFailure = await holdReleaseRefusalTx(tx, input, existing, grant);
  if (holdFailure) return holdFailure;

  const noteTrimmed = input.note?.trim() || null;

  const updated = await tx.supportCase.updateMany({
    where: {
      id: input.caseId,
      updatedAt: new Date(input.expectedUpdatedAt),
      ...(input.status || isLegalHoldOnlyPatch(input)
        ? {}
        : { status: { not: "CLOSED" } }),
    },
    data: buildLifecycleUpdateData(existing, input, noteTrimmed, now),
  });

  if ((updated?.count ?? 0) === 0) {
    return {
      ok: false as const,
      status: 409 as const,
      code: "CONFLICT" as const,
      error: "Support case was modified concurrently; please retry.",
    };
  }

  if (noteTrimmed) {
    const afterSeq = await tx.supportCase.findUniqueOrThrow({
      where: { id: input.caseId },
      select: { messageSeq: true },
    });
    await tx.supportCaseMessage.create({
      data: {
        caseId: input.caseId,
        seq: afterSeq.messageSeq,
        sender: "AGENT",
        body: noteTrimmed,
        isInternal: true,
        authorUserId: input.actorId,
        createdAt: now,
      },
    });
  }

  await recordLifecycleAuditEvents(tx, input, existing, noteTrimmed, now);
  if (
    (input.status === "RESOLVED" || input.status === "CLOSED") &&
    input.status !== existing.status
  ) {
    const note = `Released when the case was ${input.status.toLowerCase()}`;
    await recordLifecycleHoldReleaseTx(tx, {
      caseId: input.caseId,
      actorId: input.actorId,
      actorRole: grant?.actorRole ?? "UNKNOWN",
      status: input.status,
      reason: noteTrimmed ?? note,
      released: await releaseAllCaseHolds(tx, {
        caseId: input.caseId,
        actorId: input.actorId,
        note,
      }),
    });
    const endedChat = await endCaseChatAccessTx(tx, {
      caseId: input.caseId,
      actorId: input.actorId,
      reason: "CASE_RESOLVED",
      now,
    });
    scheduleChatAccessRelease(input.caseId, endedChat);
  }

  if (input.status === "RESOLVED" && existing.status !== "RESOLVED")
    await stageCaseResolutionCsatPromptTx(tx, existing, now);

  const refreshed = await tx.supportCase.findUniqueOrThrow({
    where: { id: input.caseId },
    include: CASE_RELATIONS_INCLUDE,
  });

  return {
    ok: true as const,
    previousStatus: existing.status,
    supportCase: refreshed,
  };
}

/** A staff status move the transition table refuses, with the decision in force when that is why. */
async function patchTransitionRefusalTx(
  tx: Tx,
  input: PatchSupportCaseInput,
  existing: { id: string; status: SupportCaseStatus },
) {
  if (!input.status || input.status === existing.status) return null;
  const decision =
    existing.status === "RESOLVED" || existing.status === "CLOSED"
      ? await latestCaseDecisionTx(tx, existing.id)
      : null;
  const refusal = caseTransitionRefusal(existing.status, input.status, {
    decided: decision !== null,
    actor: "STAFF",
  });
  if (!refusal) return null;
  return {
    ok: false as const,
    ...refusal,
    ...(decision ? caseDecidedDetail(decision) : {}),
  };
}

/** Update case status, priority, assignee, problem link, legal hold, internal note, and audit log atomically. */
export async function patchSupportCaseLifecycle(
  rawInput: PatchSupportCaseInput,
  now: Date = new Date(),
  grant?: HoldReleaseGrant,
) {
  const input = PatchSupportCaseSchema.parse(rawInput);

  try {
    return await prisma.$transaction(
      (tx) => executePatchLifecycleTx(tx, input, now, grant),
      { maxWait: ALLOCATION_TX_MAX_WAIT_MS, timeout: ALLOCATION_TX_TIMEOUT_MS },
    );
  } catch (error) {
    // Reopening a closed case can collide with a newer open case on the same scope.
    if (!isUniqueViolation(error)) throw error;
    const current = await prisma.supportCase.findUnique({
      where: { id: input.caseId },
    });
    const conflict = current && (await openCaseConflict(current, current.id));
    if (conflict) return { ok: false as const, ...conflict };
    throw error;
  }
}

/**
 * Enforce ADR 20 transcript redaction when requester !== submitter: an org-filed
 * case exposes safe summary fields only to the subject member and never leaks operator messages.
 */
export async function readSupportCaseForViewer(
  caseId: string,
  viewer: {
    userId: string;
    isStaff: boolean;
    role?: UserRole | null;
    canReadPayments?: boolean;
    canReadContact?: boolean;
  },
) {
  const supportCase = await prisma.supportCase.findUnique({
    where: { id: caseId },
    include: CASE_RELATIONS_INCLUDE,
  });
  if (!supportCase || supportCase.deletedAt) {
    return null;
  }

  if (supportCase.externalRequesterEmail && !viewer.isStaff) return null;
  const isRequester = viewer.userId === supportCase.requesterUserId;
  const canCorrespond =
    viewer.isStaff ||
    (await canCorrespondOnCase(supportCase, {
      userId: viewer.userId,
      role: viewer.role ?? "CONSULTEE",
    }));
  const isPresenter =
    !canCorrespond && (await isPresenterOnCase(supportCase, viewer.userId));
  const canRead = canCorrespond || isPresenter;
  if (!canRead && !isRequester) return null;

  // The member a case was filed about gets the summary whatever its scope;
  // only then does an org-owned case refuse everyone without read rights.
  const view = projectCaseForViewer(supportCase, viewer.userId, canRead);
  if (view.summaryOnly)
    return {
      ...view.summary,
      description: "",
      messages: [],
      events: [],
      subjects: [],
      viewerIsPresenter: false as const,
    };
  if (supportCase.ownershipScope !== "PERSONAL" && !canRead) return null;

  if (viewer.isStaff) {
    return projectStaffCase(supportCase, viewer);
  }

  const publicMessages = supportCase.messages
    .filter((m) => !m.isInternal)
    .map((m) => ({
      id: m.id,
      seq: m.seq,
      sender: m.sender,
      body: m.body,
      isInternal: false as const,
      clientTurnId: m.clientTurnId,
      actorKind: isPresenterAuthoredMessage(m.metadata)
        ? ("PRESENTER" as const)
        : undefined,
      createdAt: m.createdAt,
    }));

  return {
    id: supportCase.id,
    referenceNumber: supportCase.referenceNumber,
    title: supportCase.title,
    description: supportCase.description,
    category: supportCase.category,
    activeChannel: supportCase.activeChannel,
    issueType: supportCase.issueType,
    priority: supportCase.priority,
    status: supportCase.status,
    caseKind: supportCase.caseKind,
    ownershipScope: supportCase.ownershipScope,
    requesterUserId: supportCase.requesterUserId,
    submitterUserId: supportCase.submitterUserId,
    organizationId: supportCase.organizationId,
    appointmentId: supportCase.appointmentId,
    appointmentOccurrenceId: supportCase.appointmentOccurrenceId,
    assignedToId: null,
    // The callback number belongs to whoever filed; co-operators never see it.
    callbackPhone:
      viewer.userId === supportCase.submitterUserId
        ? supportCase.callbackPhone
        : null,
    callbackWindow: isPresenter ? null : supportCase.callbackWindow,
    ackDueAt: supportCase.ackDueAt,
    acknowledgedAt: supportCase.acknowledgedAt,
    resolutionDueAt: supportCase.resolutionDueAt,
    resolvedAt: supportCase.resolvedAt,
    closedAt: supportCase.closedAt,
    firstAgentReplyAt: supportCase.firstAgentReplyAt,
    lastMessageAt: supportCase.lastMessageAt,
    csatRating: isPresenter ? null : supportCase.csatRating,
    csatAt: isPresenter ? null : supportCase.csatAt,
    receivedAt: supportCase.receivedAt,
    createdAt: supportCase.createdAt,
    updatedAt: supportCase.updatedAt,
    subjects: supportCase.subjects
      .filter(
        (subject) =>
          !isPresenter ||
          !["PAYMENT", "REFUND", "INVOICE"].includes(subject.subjectType),
      )
      .map((subject) => ({
        id: subject.id,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        isPrimary: subject.isPrimary,
      })),
    messages: publicMessages,
    events: supportCase.events
      .filter((e) =>
        ["CREATED", "STATUS_CHANGED", "REOPENED", "AUTO_CLOSED"].includes(
          e.kind,
        ),
      )
      .map((event) => ({
        id: event.id,
        kind: event.kind,
        fromValue: event.fromValue,
        toValue: event.toValue,
        createdAt: event.createdAt,
        actorId: null,
        note: null,
      })),
    filedByOrganizationNotice: false as const,
    viewerIsPresenter: isPresenter,
  };
}

async function executeSubmitCsatTx(
  tx: Tx,
  input: SubmitSupportCaseCsatInput,
  now: Date,
) {
  const existing = await tx.supportCase.findUnique({
    where: { id: input.caseId },
  });
  if (!existing) {
    return {
      ok: false as const,
      status: 404 as const,
      error: "Support case not found.",
    };
  }

  if (
    !(await canCorrespondOnCase(
      existing,
      { userId: input.userId, role: "CONSULTEE" },
      tx,
    ))
  ) {
    return {
      ok: false as const,
      status: 404 as const,
      error: "Support case not found.",
    };
  }

  if (existing.status !== "RESOLVED" && existing.status !== "CLOSED") {
    return {
      ok: false as const,
      status: 400 as const,
      error: "Only resolved or closed cases can be rated.",
    };
  }

  if (
    !existing.resolvedAt ||
    now.getTime() - existing.resolvedAt.getTime() > TWENTY_EIGHT_DAYS_MS
  ) {
    return {
      ok: false as const,
      status: 400 as const,
      error: "The 28-day survey window for this case has expired.",
    };
  }

  const updated = await tx.supportCase.updateMany({
    where: {
      id: input.caseId,
      status: { in: ["RESOLVED", "CLOSED"] },
      csatRating: null,
    },
    data: {
      csatRating: input.rating,
      csatAt: now,
    },
  });

  if (updated.count === 0) {
    return {
      ok: false as const,
      status: 409 as const,
      error: "This case has already been rated.",
    };
  }

  await tx.supportCaseEvent.create({
    data: {
      caseId: input.caseId,
      actorId: input.userId,
      kind: "CSAT_RATED",
      toValue: String(input.rating),
      createdAt: now,
    },
  });

  return {
    ok: true as const,
    csatRating: input.rating,
    csatAt: now,
  };
}

/** Record CSAT rating (1-5) within 28 days of resolution using CAS on csatRating IS NULL. */
export async function submitSupportCaseCsat(
  rawInput: SubmitSupportCaseCsatInput,
  now: Date = new Date(),
) {
  const input = SubmitSupportCaseCsatSchema.parse(rawInput);

  try {
    return await prisma.$transaction(
      (tx) => executeSubmitCsatTx(tx, input, now),
      {
        maxWait: ALLOCATION_TX_MAX_WAIT_MS,
        timeout: ALLOCATION_TX_TIMEOUT_MS,
      },
    );
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return {
        ok: false as const,
        status: 409 as const,
        error: "This case has already been rated.",
      };
    }
    throw err;
  }
}

/** Category deadlines are absolute; monthly reporting never subtracts customer waiting time. */
export async function supportMonthlyComplianceReport(
  year: number,
  month: number,
) {
  const startUtc = new Date(Date.UTC(year, month - 1, 1) - IST_OFFSET_MS);
  const endUtc = new Date(Date.UTC(year, month, 1) - IST_OFFSET_MS);
  const rows = await prisma.supportCase.findMany({
    where: {
      receivedAt: { gte: startUtc, lt: endUtc },
      activeChannel: "HUMAN",
      deletedAt: null,
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      referenceNumber: true,
      category: true,
      status: true,
      createdAt: true,
      receivedAt: true,
      acknowledgedAt: true,
      resolvedAt: true,
      statutoryDueAt: true,
      appealOfDecisionId: true,
      appealOfModerationActionId: true,
    },
  });
  const cases = rows.map((row) => {
    const due =
      row.statutoryDueAt ??
      supportDeadline(row.category, row.receivedAt ?? row.createdAt)
        .statutoryDueAt;
    return {
      id: row.id,
      source: "case" as const,
      referenceNumber: row.referenceNumber,
      category: row.category,
      status: row.status,
      createdAt: row.receivedAt ?? row.createdAt,
      acknowledgedAt: row.acknowledgedAt,
      resolvedAt: row.resolvedAt,
      statutoryDueAt: due,
      acknowledgedWithin24h: Boolean(
        row.acknowledgedAt &&
        row.acknowledgedAt.getTime() -
          (row.receivedAt ?? row.createdAt).getTime() <=
          TWENTY_FOUR_HOURS_MS,
      ),
      resolvedWithinDeadline: Boolean(row.resolvedAt && row.resolvedAt <= due),
      grievance: row.category === "GRIEVANCE",
      appealed: Boolean(
        row.appealOfDecisionId || row.appealOfModerationActionId,
      ),
    };
  });
  return {
    year,
    month,
    received: cases.length,
    acknowledgedWithin24h: cases.filter((row) => row.acknowledgedWithin24h)
      .length,
    resolvedWithinDeadline: cases.filter((row) => row.resolvedWithinDeadline)
      .length,
    grievances: cases.filter((row) => row.grievance).length,
    appealed: cases.filter((row) => row.appealed).length,
    cases,
  };
}
