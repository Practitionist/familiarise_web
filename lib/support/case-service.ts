import { z } from "zod";
import { SupportIssueTypeEnum } from "@/schemas/enums";
import prisma, {
  ALLOCATION_TX_MAX_WAIT_MS,
  ALLOCATION_TX_TIMEOUT_MS,
} from "@/lib/prisma";
import { allocateTicketReference } from "./reference";
import {
  openWaitSeconds,
  slaDeadlinesFor,
  tightenDeadlinesForPriorityRaise,
  userRepliedPatch,
} from "./sla";

const IST_OFFSET_MS = 330 * 60_000;
const TWENTY_EIGHT_DAYS_MS = 28 * 24 * 3_600_000;
const TWENTY_FOUR_HOURS_MS = 24 * 3_600_000;
const FIFTEEN_DAYS_MS = 15 * 24 * 3_600_000;

export const SupportCaseStatusSchema = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "ESCALATED",
  "ON_HOLD",
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
  appointmentId: z.string().min(1).max(64).nullable().optional(),
  appointmentOccurrenceId: z.string().min(1).max(64).nullable().optional(),
  callbackPhone: z.string().trim().max(32).nullable().optional(),
  callbackWindow: z.string().trim().max(64).nullable().optional(),
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
  body: z.string().trim().min(1).max(10_000),
  isInternal: z.boolean().default(false),
  clientTurnId: z.string().trim().min(1).max(128).nullable().optional(),
  expectedLastMessageAt: z.string().datetime().optional(),
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

/** Create a unified support case or return an existing match via clientIntakeId or open-scope dedupe. */
export async function createOrReuseSupportCase(
  rawInput: CreateSupportCaseInput,
  now: Date = new Date(),
) {
  const input = CreateSupportCaseInputSchema.parse(rawInput);

  return prisma.$transaction(
    async (tx) => {
      if (input.clientIntakeId) {
        const replayed = await tx.supportCase.findUnique({
          where: { clientIntakeId: input.clientIntakeId },
          include: {
            subjects: true,
            messages: { orderBy: { seq: "asc" } },
            events: { orderBy: { createdAt: "asc" } },
          },
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
          appointmentId: input.appointmentId ?? null,
          appointmentOccurrenceId: input.appointmentOccurrenceId ?? null,
          category: input.category ?? null,
          closedAt: null,
          deletedAt: null,
        },
        include: {
          subjects: true,
          messages: { orderBy: { seq: "asc" } },
          events: { orderBy: { createdAt: "asc" } },
        },
      });
      if (existingOpen) {
        return {
          supportCase: existingOpen,
          reused: true,
          dedupeReason: "open_scope" as const,
        };
      }

      const priority = input.priority ?? "MEDIUM";
      const referenceNumber = await allocateTicketReference(tx, now);
      const { ackDueAt, resolutionDueAt } = slaDeadlinesFor(priority, now);

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

      const caseKind = input.caseKind ?? "INCIDENT";
      const created = await tx.supportCase.create({
        data: {
          referenceNumber,
          clientIntakeId: input.clientIntakeId ?? null,
          title: input.title,
          description: input.description,
          category: input.category ?? null,
          flowKey: input.flowKey ?? null,
          currentNodeId: input.currentNodeId ?? null,
          activeChannel: input.activeChannel ?? "SELF_SERVE",
          issueType: input.issueType ?? null,
          priority,
          status: "OPEN",
          caseKind,
          problemCaseId:
            caseKind === "PROBLEM" ? null : (input.problemCaseId ?? null),
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
            create: [...subjectMap.values()],
          },
          messages: {
            create: [
              {
                seq: 1,
                sender: "USER",
                body: input.description,
                isInternal: false,
                clientTurnId: input.clientIntakeId ?? null,
                authorUserId: input.submitterUserId,
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
        include: {
          subjects: true,
          messages: { orderBy: { seq: "asc" } },
          events: { orderBy: { createdAt: "asc" } },
        },
      });

      return {
        supportCase: created,
        reused: false,
        dedupeReason: null,
      };
    },
    {
      maxWait: ALLOCATION_TX_MAX_WAIT_MS,
      timeout: ALLOCATION_TX_TIMEOUT_MS,
    },
  );
}

/** Append a message turn idempotently via clientTurnId and advance SLA/status via CAS. */
export async function appendSupportCaseTurn(
  rawInput: AppendSupportCaseTurnInput,
  now: Date = new Date(),
) {
  const input = AppendSupportCaseTurnSchema.parse(rawInput);

  return prisma.$transaction(
    async (tx) => {
      if (input.clientTurnId) {
        const existingTurn = await tx.supportCaseMessage.findUnique({
          where: {
            caseId_clientTurnId: {
              caseId: input.caseId,
              clientTurnId: input.clientTurnId,
            },
          },
          select: { seq: true },
        });
        if (existingTurn) {
          const subsequent = await tx.supportCaseMessage.findMany({
            where: {
              caseId: input.caseId,
              seq: { gte: existingTurn.seq },
              ...(input.sender !== "AGENT" ? { isInternal: false } : {}),
            },
            orderBy: { seq: "asc" },
          });
          return {
            ok: true as const,
            replayed: true,
            messages: subsequent,
          };
        }
      }

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

      if (
        input.sender === "AGENT" &&
        !input.isInternal &&
        input.expectedLastMessageAt &&
        existingCase.lastMessageAt &&
        existingCase.lastMessageAt.getTime() >
          new Date(input.expectedLastMessageAt).getTime()
      ) {
        return {
          ok: false as const,
          status: 409 as const,
          code: "NEW_CUSTOMER_MESSAGE" as const,
          error:
            "Customer replied since you opened this case. Review their message before sending.",
        };
      }

      if (input.sender === "USER") {
        const nextStatus =
          existingCase.status === "RESOLVED" ||
          existingCase.status === "ON_HOLD"
            ? existingCase.assignedToId
              ? "IN_PROGRESS"
              : "OPEN"
            : existingCase.status;
        const moved = await tx.supportCase.updateMany({
          where: {
            id: input.caseId,
            status: existingCase.status,
            awaitingUserSince: existingCase.awaitingUserSince,
            pausedSeconds: existingCase.pausedSeconds,
          },
          data: {
            messageSeq: { increment: 1 },
            lastMessageAt: now,
            status: nextStatus,
            resolvedAt: null,
            closedAt: null,
            ...userRepliedPatch(existingCase, now),
          },
        });
        if (moved.count === 0) {
          return {
            ok: false as const,
            status: 409 as const,
            code: "CONFLICT" as const,
            error: "Support case was updated concurrently.",
          };
        }
        if (
          existingCase.status === "RESOLVED" ||
          existingCase.status === "ON_HOLD"
        ) {
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
      } else if (input.sender === "AGENT" && !input.isInternal) {
        const waitDelta = openWaitSeconds(existingCase, now);
        const moved = await tx.supportCase.updateMany({
          where: {
            id: input.caseId,
            status: { not: "CLOSED" },
            awaitingUserSince: existingCase.awaitingUserSince,
          },
          data: {
            messageSeq: { increment: 1 },
            lastMessageAt: now,
            acknowledgedAt: existingCase.acknowledgedAt ?? now,
            firstAgentReplyAt: existingCase.firstAgentReplyAt ?? now,
            awaitingUserSince: now,
            pausedSeconds: existingCase.pausedSeconds + waitDelta,
            ...(existingCase.status === "OPEN"
              ? {
                  status: "IN_PROGRESS",
                  assignedToId:
                    existingCase.assignedToId ?? input.authorUserId ?? null,
                }
              : {}),
          },
        });
        if (moved.count === 0) {
          return {
            ok: false as const,
            status: 409 as const,
            code: "CONFLICT" as const,
            error: "Support case was updated concurrently.",
          };
        }
      } else {
        await tx.supportCase.updateMany({
          where: { id: input.caseId },
          data: {
            messageSeq: { increment: 1 },
            ...(input.isInternal ? {} : { lastMessageAt: now }),
          },
        });
      }

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
          createdAt: now,
        },
      });

      return {
        ok: true as const,
        replayed: false,
        messages: [created],
      };
    },
    {
      maxWait: ALLOCATION_TX_MAX_WAIT_MS,
      timeout: ALLOCATION_TX_TIMEOUT_MS,
    },
  );
}

/** Update case status, priority, assignee, problem link, internal reassignment note, and audit log atomically. */
export async function patchSupportCaseLifecycle(
  rawInput: PatchSupportCaseInput,
  now: Date = new Date(),
) {
  const input = PatchSupportCaseSchema.parse(rawInput);

  if (input.status === "ON_HOLD") {
    return {
      ok: false as const,
      status: 400 as const,
      code: "STATUS_NOT_SUPPORTED" as const,
      error:
        "On hold is not supported; use Waiting on customer or leave an internal note.",
    };
  }

  return prisma.$transaction(
    async (tx) => {
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

      if (existing.status === "CLOSED" && !input.status) {
        return {
          ok: false as const,
          status: 400 as const,
          code: "CASE_CLOSED" as const,
          error:
            "This case is closed, so assignee and priority cannot change until it is reopened.",
        };
      }

      const tightened =
        input.priority && input.priority !== existing.priority
          ? tightenDeadlinesForPriorityRaise(existing, input.priority, now)
          : {};

      const noteTrimmed = input.note?.trim() || null;

      const updated = await tx.supportCase.updateMany({
        where: {
          id: input.caseId,
          updatedAt: new Date(input.expectedUpdatedAt),
          ...(input.status ? {} : { status: { not: "CLOSED" } }),
        },
        data: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.status === "RESOLVED"
            ? { resolvedAt: now, closedAt: null }
            : {}),
          ...(input.status === "CLOSED"
            ? { closedAt: now, resolvedAt: existing.resolvedAt ?? now }
            : {}),
          ...(input.status &&
          input.status !== "RESOLVED" &&
          input.status !== "CLOSED"
            ? { resolvedAt: null, closedAt: null }
            : {}),
          ...(input.priority ? { priority: input.priority } : {}),
          ...tightened,
          ...(input.assignedToId !== undefined
            ? { assignedToId: input.assignedToId }
            : {}),
          ...(input.problemCaseId !== undefined &&
          existing.caseKind === "INCIDENT"
            ? { problemCaseId: input.problemCaseId }
            : {}),
          ...(noteTrimmed ? { messageSeq: { increment: 1 } } : {}),
        },
      });

      if (updated.count === 0) {
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

      if (input.status && input.status !== existing.status) {
        const isReopen =
          (existing.status === "RESOLVED" || existing.status === "CLOSED") &&
          (input.status === "OPEN" || input.status === "IN_PROGRESS");
        await tx.supportCaseEvent.create({
          data: {
            caseId: input.caseId,
            actorId: input.actorId,
            kind: isReopen ? "REOPENED" : "STATUS_CHANGED",
            fromValue: existing.status,
            toValue: input.status,
            createdAt: now,
          },
        });
      }

      if (input.priority && input.priority !== existing.priority) {
        await tx.supportCaseEvent.create({
          data: {
            caseId: input.caseId,
            actorId: input.actorId,
            kind: "PRIORITY_CHANGED",
            fromValue: existing.priority,
            toValue: input.priority,
            createdAt: now,
          },
        });
      }

      if (
        input.assignedToId !== undefined &&
        input.assignedToId !== existing.assignedToId
      ) {
        await tx.supportCaseEvent.create({
          data: {
            caseId: input.caseId,
            actorId: input.actorId,
            kind: input.assignedToId ? "ASSIGNED" : "UNASSIGNED",
            fromValue: existing.assignedToId,
            toValue: input.assignedToId,
            note: noteTrimmed,
            createdAt: now,
          },
        });
      }

      if (
        input.problemCaseId !== undefined &&
        existing.caseKind === "INCIDENT" &&
        input.problemCaseId !== existing.problemCaseId
      ) {
        await tx.supportCaseEvent.create({
          data: {
            caseId: input.caseId,
            actorId: input.actorId,
            kind: "LINKED_PROBLEM",
            fromValue: existing.problemCaseId,
            toValue: input.problemCaseId,
            createdAt: now,
          },
        });
      }

      // Solving a PROBLEM resolves open linked incidents and copies the closing message;
      // reopening a PROBLEM deliberately leaves solved incidents untouched.
      if (existing.caseKind === "PROBLEM" && input.status === "RESOLVED") {
        const openIncidents = await tx.supportCase.findMany({
          where: {
            problemCaseId: existing.id,
            caseKind: "INCIDENT",
            status: { notIn: ["RESOLVED", "CLOSED"] },
            deletedAt: null,
          },
          select: { id: true, status: true, messageSeq: true },
        });
        const closingMsg = input.closingMessage?.trim() || null;

        for (const inc of openIncidents) {
          const movedInc = await tx.supportCase.updateMany({
            where: { id: inc.id, status: inc.status },
            data: {
              status: "RESOLVED",
              resolvedAt: now,
              closedAt: null,
              ...(closingMsg
                ? { messageSeq: { increment: 1 }, lastMessageAt: now }
                : {}),
            },
          });
          if (movedInc.count > 0) {
            if (closingMsg) {
              await tx.supportCaseMessage.create({
                data: {
                  caseId: inc.id,
                  seq: inc.messageSeq + 1,
                  sender: "AGENT",
                  body: closingMsg,
                  isInternal: false,
                  authorUserId: input.actorId,
                  createdAt: now,
                },
              });
            }
            await tx.supportCaseEvent.create({
              data: {
                caseId: inc.id,
                actorId: input.actorId,
                kind: "STATUS_CHANGED",
                fromValue: inc.status,
                toValue: "RESOLVED",
                note: `Resolved via problem ${existing.referenceNumber}`,
                createdAt: now,
              },
            });
          }
        }
      }

      const refreshed = await tx.supportCase.findUniqueOrThrow({
        where: { id: input.caseId },
        include: {
          subjects: true,
          messages: { orderBy: { seq: "asc" } },
          events: { orderBy: { createdAt: "asc" } },
        },
      });

      return {
        ok: true as const,
        previousStatus: existing.status,
        supportCase: refreshed,
      };
    },
    {
      maxWait: ALLOCATION_TX_MAX_WAIT_MS,
      timeout: ALLOCATION_TX_TIMEOUT_MS,
    },
  );
}

/**
 * Enforce ADR 20 transcript redaction when requester !== submitter: an org-filed
 * case exposes metadata only to the subject member and never leaks operator messages.
 */
export async function readSupportCaseForViewer(
  caseId: string,
  viewer: { userId: string; isStaff: boolean },
) {
  const supportCase = await prisma.supportCase.findUnique({
    where: { id: caseId },
    include: {
      subjects: true,
      messages: { orderBy: { seq: "asc" } },
      events: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!supportCase || supportCase.deletedAt) {
    return null;
  }

  const isSubmitter = viewer.userId === supportCase.submitterUserId;
  const isRequester = viewer.userId === supportCase.requesterUserId;
  if (!viewer.isStaff && !isSubmitter && !isRequester) {
    return null;
  }

  if (
    !viewer.isStaff &&
    viewer.userId === supportCase.requesterUserId &&
    supportCase.requesterUserId !== supportCase.submitterUserId
  ) {
    return {
      id: supportCase.id,
      referenceNumber: supportCase.referenceNumber,
      status: supportCase.status,
      category: supportCase.category,
      createdAt: supportCase.createdAt,
      organizationId: supportCase.organizationId,
      requesterUserId: supportCase.requesterUserId,
      submitterUserId: supportCase.submitterUserId,
      messages: [],
      filedByOrganizationNotice: true as const,
    };
  }

  if (viewer.isStaff) {
    return {
      ...supportCase,
      filedByOrganizationNotice: false as const,
    };
  }

  return {
    ...supportCase,
    messages: supportCase.messages.filter((m) => !m.isInternal),
    events: supportCase.events.filter((e) => e.kind !== "VISIBILITY_CHANGED"),
    filedByOrganizationNotice: false as const,
  };
}

/** Record CSAT rating (1-5) within 28 days of resolution using CAS on csatRating IS NULL. */
export async function submitSupportCaseCsat(
  rawInput: SubmitSupportCaseCsatInput,
  now: Date = new Date(),
) {
  const input = SubmitSupportCaseCsatSchema.parse(rawInput);

  return prisma.$transaction(
    async (tx) => {
      const existing = await tx.supportCase.findUnique({
        where: { id: input.caseId },
      });
      if (!existing) {
        const legacyTicket = await tx.supportTicket.findUnique({
          where: { id: input.caseId },
        });
        if (!legacyTicket || legacyTicket.userId !== input.userId) {
          return {
            ok: false as const,
            status: 404 as const,
            error: "Support case not found.",
          };
        }
        if (
          legacyTicket.status !== "RESOLVED" &&
          legacyTicket.status !== "CLOSED"
        ) {
          return {
            ok: false as const,
            status: 400 as const,
            error: "Only resolved or closed cases can be rated.",
          };
        }
        if (
          !legacyTicket.resolvedAt ||
          now.getTime() - legacyTicket.resolvedAt.getTime() >
            TWENTY_EIGHT_DAYS_MS
        ) {
          return {
            ok: false as const,
            status: 400 as const,
            error: "The 28-day survey window for this case has expired.",
          };
        }
        const existingEvent = await tx.supportCaseEvent.findFirst({
          where: {
            legacyTicketId: input.caseId,
            kind: "CSAT_RATED",
          },
          select: { id: true },
        });
        if (existingEvent) {
          return {
            ok: false as const,
            status: 409 as const,
            error: "This case has already been rated.",
          };
        }
        await tx.supportCaseEvent.create({
          data: {
            legacyTicketId: input.caseId,
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

      if (
        existing.requesterUserId !== input.userId &&
        existing.submitterUserId !== input.userId
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
    },
    {
      maxWait: ALLOCATION_TX_MAX_WAIT_MS,
      timeout: ALLOCATION_TX_TIMEOUT_MS,
    },
  );
}

/** Statutory monthly compliance report across unified SupportCase and legacy SupportTicket for an IST month. */
export async function supportMonthlyComplianceReport(
  year: number,
  month: number,
) {
  const startUtc = new Date(
    Date.UTC(year, month - 1, 1, 0, 0, 0, 0) - IST_OFFSET_MS,
  );
  const endUtc = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0) - IST_OFFSET_MS);

  const [supportCases, legacyTickets] = await Promise.all([
    prisma.supportCase.findMany({
      where: {
        createdAt: { gte: startUtc, lt: endUtc },
        deletedAt: null,
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        referenceNumber: true,
        category: true,
        status: true,
        createdAt: true,
        acknowledgedAt: true,
        resolvedAt: true,
        pausedSeconds: true,
      },
    }),
    prisma.supportTicket.findMany({
      where: {
        createdAt: { gte: startUtc, lt: endUtc },
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        referenceNumber: true,
        category: true,
        status: true,
        createdAt: true,
        acknowledgedAt: true,
        resolvedAt: true,
        pausedSeconds: true,
      },
    }),
  ]);

  const rows = [
    ...supportCases.map((c) => ({ ...c, source: "case" as const })),
    ...legacyTickets.map((t) => ({ ...t, source: "ticket" as const })),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  let acknowledgedWithin24h = 0;
  let disposedWithin15d = 0;
  let appealed = 0;

  const cases = rows.map((r) => {
    const ackOk =
      r.acknowledgedAt !== null &&
      r.acknowledgedAt.getTime() - r.createdAt.getTime() <=
        TWENTY_FOUR_HOURS_MS;
    const dispOk =
      r.resolvedAt !== null &&
      r.resolvedAt.getTime() - r.createdAt.getTime() - r.pausedSeconds * 1000 <=
        FIFTEEN_DAYS_MS;
    const isAppealed =
      r.category === "GRIEVANCE" || r.category === "MODERATION_APPEAL";

    if (ackOk) acknowledgedWithin24h++;
    if (dispOk) disposedWithin15d++;
    if (isAppealed) appealed++;

    return {
      id: r.id,
      source: r.source,
      referenceNumber: r.referenceNumber,
      category: r.category,
      status: r.status,
      createdAt: r.createdAt,
      acknowledgedAt: r.acknowledgedAt,
      resolvedAt: r.resolvedAt,
      pausedSeconds: r.pausedSeconds,
      acknowledgedWithin24h: ackOk,
      disposedWithin15d: dispOk,
      appealed: isAppealed,
    };
  });

  return {
    year,
    month,
    received: rows.length,
    acknowledgedWithin24h,
    disposedWithin15d,
    appealed,
    cases,
  };
}
