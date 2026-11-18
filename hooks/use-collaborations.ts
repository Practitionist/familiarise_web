"use client";

/**
 * Every read and write the collaborator screens make. All lists live under one
 * query root, and every write refreshes that root whatever its outcome: a
 * success changed the lists, and a refusal usually means a list was stale.
 */

import { CollaboratorRole } from "@prisma/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  formatDay,
  formatSessionDay,
  formatSessionHours,
} from "@/components/collaborators/format";
import type {
  CollaborationsData,
  TeamMember,
} from "@/components/collaborators/types";
import { useZoneClock } from "@/lib/time/use-zone-clock";
import { seenTermsSchema, type SeenTerms } from "@/schemas/collaborators";

export type PlanRef = { planType: "webinar" | "class"; planId: string };

export const collaborationKeys = {
  all: ["collaborations"] as const,
  mine: (orgScope?: string, orgView = false) =>
    ["collaborations", "mine", orgScope ?? "personal", orgView] as const,
  plan: (ref: PlanRef) =>
    ["collaborations", "plan", ref.planType, ref.planId] as const,
};

const refusalBodySchema = z.object({
  error: z.string().min(1),
  code: z.string().optional(),
  // A detail of an unexpected shape is dropped; the server's sentence still shows.
  terms: seenTermsSchema.optional().catch(undefined),
  retryAt: z.string().datetime().optional().catch(undefined),
  availablePercent: z.number().optional().catch(undefined),
  retryAfterSeconds: z.number().optional().catch(undefined),
  // The plan's session an accept clashed on.
  clash: z
    .object({ startsAt: z.string().datetime(), endsAt: z.string().datetime() })
    .optional()
    .catch(undefined),
});

type RefusalDetail = Omit<z.infer<typeof refusalBodySchema>, "error" | "code">;

/** A write or read the server refused: its sentence, its stable code and the facts to recover with. */
export class CollaborationRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly detail: RefusalDetail = {},
    /** The zone the screen that made the call prints times in; null when no screen did. */
    readonly zone: string | null = null,
  ) {
    super(message);
    this.name = "CollaborationRefusal";
  }

  /** The same refusal, for a screen that prints times in `zone`. */
  inZone(zone: string): CollaborationRefusal {
    return new CollaborationRefusal(
      this.code,
      this.message,
      this.status,
      this.detail,
      zone,
    );
  }
}

const UNREADABLE = "Something went wrong. Please try again.";
const UNREACHABLE =
  "We couldn't reach the server. Check your connection and try again.";

/** The body of a 2xx answer, or a `CollaborationRefusal` for anything else. */
async function call(url: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new CollaborationRefusal("NETWORK", UNREACHABLE, 0);
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) return body;
  const refusal = refusalBodySchema.safeParse(body);
  if (!refusal.success) {
    throw new CollaborationRefusal("UNKNOWN", UNREADABLE, res.status);
  }
  const { error, code, ...detail } = refusal.data;
  throw new CollaborationRefusal(code ?? "UNKNOWN", error, res.status, detail);
}

/** Reads an answer through its schema; an answer of another shape is a failed load, not an empty one. */
async function read<T>(
  url: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T> {
  const parsed = schema.safeParse(await call(url));
  if (!parsed.success) throw new CollaborationRefusal("UNKNOWN", UNREADABLE, 0);
  return parsed.data;
}

const write = (
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: object,
) =>
  call(url, {
    method,
    ...(body
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });

const planUrl = (ref: PlanRef) =>
  `/api/collaborations/${ref.planType}/${encodeURIComponent(ref.planId)}`;

const isRecord = (value: unknown): boolean =>
  typeof value === "object" && value !== null;

/** The list payload is this app's own route; only its envelope is checked here. */
const myCollaborationsSchema = z.object({
  data: z.custom<CollaborationsData>(isRecord),
});

/** The viewer's invitations, the plans they help deliver and the plans they host with a team. */
export function useMyCollaborations({
  orgScope,
  orgView = false,
}: { orgScope?: string; orgView?: boolean } = {}) {
  return useQuery<CollaborationsData, CollaborationRefusal>({
    queryKey: collaborationKeys.mine(orgScope, orgView),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (orgScope) {
        params.set("orgScope", orgScope);
        if (orgView) params.set("view", "org");
      }
      const query = params.toString();
      const { data } = await read(
        query ? `/api/collaborations?${query}` : "/api/collaborations",
        myCollaborationsSchema,
      );
      return data;
    },
    staleTime: 30_000,
    // An inbox: a visit always asks again, whatever the app-wide default.
    refetchOnMount: "always",
  });
}

const personSchema = z.object({
  name: z.string().nullable(),
  image: z.string().nullable(),
});

/** One live row of a plan's team. The caps and the running total are computed from these. */
const teamMemberSchema: z.ZodType<TeamMember, z.ZodTypeDef, unknown> = z.object(
  {
    id: z.string(),
    role: z.nativeEnum(CollaboratorRole),
    status: z.enum(["PENDING", "ACCEPTED"]),
    revenueShareBps: z.number().int().nullable(),
    expiresAt: z.string().nullable().optional(),
    consultantProfile: z.object({ id: z.string(), user: personSchema }),
  },
);

const planTeamSchema = z.object({
  data: z.array(teamMemberSchema),
  viewer: z.enum(["manager", "presenter", "crew", "invitee"]),
  canManage: z.boolean(),
});

type PlanTeam = {
  members: TeamMember[];
  viewer: z.infer<typeof planTeamSchema>["viewer"];
  canManage: boolean;
};

/** One plan's invited and accepted collaborators, as this viewer may see them. */
export function usePlanTeam(ref: PlanRef) {
  return useQuery<PlanTeam, CollaborationRefusal>({
    queryKey: collaborationKeys.plan(ref),
    queryFn: async () => {
      const { data, viewer, canManage } = await read(
        planUrl(ref),
        planTeamSchema,
      );
      return { members: data, viewer, canManage };
    },
    staleTime: 30_000,
  });
}

/** Asks every collaboration list on screen to load again. */
export function useReloadCollaborations(): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: collaborationKeys.all });
  };
}

function useCollaborationWrite<TArgs>(
  mutationFn: (args: TArgs) => Promise<unknown>,
) {
  const reload = useReloadCollaborations();
  const { zone } = useZoneClock();
  return useMutation<unknown, CollaborationRefusal, TArgs>({
    // A refusal carries the screen's zone, so its sentence can name a time.
    mutationFn: async (args) => {
      try {
        return await mutationFn(args);
      } catch (error) {
        throw error instanceof CollaborationRefusal
          ? error.inZone(zone)
          : error;
      }
    },
    // Not awaited: the answer reaches the screen first, the fresh lists follow.
    onSettled: reload,
  });
}

type InviteArgs = {
  consultantProfileId: string;
  role: CollaboratorRole;
  sharePercent: number;
};

/** A manager invites an expert onto the plan. */
export function useInviteCollaborator(ref: PlanRef) {
  return useCollaborationWrite((args: InviteArgs) =>
    write(planUrl(ref), "POST", args),
  );
}

type UpdateTermsArgs = {
  collaboratorId: string;
  role?: CollaboratorRole;
  sharePercent?: number;
};

/** A manager changes a pending invitation's role, share or both. */
export function useUpdatePendingTerms(ref: PlanRef) {
  return useCollaborationWrite(
    ({ collaboratorId, ...terms }: UpdateTermsArgs) =>
      write(
        `${planUrl(ref)}/${encodeURIComponent(collaboratorId)}`,
        "PATCH",
        terms,
      ),
  );
}

/** A manager removes a row or cancels an invitation; a collaborator leaves their own. */
export function useEndCollaboration(ref: PlanRef) {
  return useCollaborationWrite((collaboratorId: string) =>
    write(`${planUrl(ref)}/${encodeURIComponent(collaboratorId)}`, "DELETE"),
  );
}

type RespondArgs =
  | { collaboratorId: string; response: "ACCEPTED"; seenTerms: SeenTerms }
  | { collaboratorId: string; response: "DECLINED" };

/** The invitee answers. An accept names the terms on screen, so a change in between is refused. */
export function useRespondToInvitation() {
  return useCollaborationWrite(({ collaboratorId, ...answer }: RespondArgs) =>
    write(
      `/api/collaborations/${encodeURIComponent(collaboratorId)}/respond`,
      "PATCH",
      answer,
    ),
  );
}

/** Codes whose refusal means the screen was showing something that has since changed. */
const RELOAD_CODES = new Set([
  "SCHEDULE_CHANGED",
  "CONFLICT",
  "NOT_PENDING",
  "TERMS_LOCKED",
]);

type RefusalAdvice = {
  /**
   * The refusal and how to recover, said once: the screen's own sentence when
   * it holds the exact date, wait or session, the server's sentence otherwise.
   */
  sentence: string;
  /** Offer a reload: the lists on screen are out of date. */
  reload: boolean;
};

/** The whole sentence for a refusal whose facts the screen can state exactly. */
function exactRecovery(refusal: CollaborationRefusal): string | null {
  const { retryAt, retryAfterSeconds, clash } = refusal.detail;
  if (refusal.code === "CALENDAR_CLASH" && clash && refusal.zone) {
    const day = formatSessionDay(clash.startsAt, refusal.zone);
    const hours = formatSessionHours(
      clash.startsAt,
      clash.endsAt,
      refusal.zone,
    );
    return `This plan's session on ${day}, ${hours} overlaps another session on your calendar.`;
  }
  if (refusal.code === "COOLDOWN" && retryAt) {
    return `This expert recently declined or left this plan, and can be invited again from ${formatDay(retryAt)}.`;
  }
  if (refusal.code === "RATE_LIMITED" && retryAfterSeconds !== undefined) {
    const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    const unit = minutes === 1 ? "minute" : "minutes";
    return `You have made too many requests; try again in about ${minutes} ${unit}.`;
  }
  return null;
}

/** What a plan still has to give, after a refusal that counted its shares. */
function sharesLeft(refusal: CollaborationRefusal): string | null {
  const { availablePercent } = refusal.detail;
  if (refusal.code !== "SHARES_EXCEEDED" || availablePercent === undefined) {
    return null;
  }
  return availablePercent >= 1
    ? `${availablePercent}% is still free on this plan.`
    : "No share is left to give on this plan.";
}

/** What to tell the person about a refusal. The branch is the code, never the wording. */
export function describeRefusal(refusal: CollaborationRefusal): RefusalAdvice {
  const left = sharesLeft(refusal);
  const sentence =
    exactRecovery(refusal) ??
    (left ? `${refusal.message} ${left}` : refusal.message);
  return { sentence, reload: RELOAD_CODES.has(refusal.code) };
}
