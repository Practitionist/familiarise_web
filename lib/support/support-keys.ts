import type { QueryClient } from "@tanstack/react-query";

/** Every support query key lives under ["support"], so a case mutation refreshes its subtree. */
export const supportKeys = {
  all: ["support"] as const,
  case: (caseId: string) => ["support", "case", caseId] as const,
  workspace: (caseId: string) =>
    [...supportKeys.case(caseId), "workspace"] as const,
  ownCase: (caseId: string) => [...supportKeys.case(caseId), "own"] as const,
  resolution: (caseId: string) =>
    [...supportKeys.case(caseId), "resolution"] as const,
  attachments: (caseId: string, evidenceRequestId?: string) =>
    [
      ...supportKeys.case(caseId),
      "attachments",
      evidenceRequestId ?? "case",
    ] as const,
  threads: () => ["support", "thread"] as const,
  /** A session's page has its own entry, so one session's thread never answers on another's page. */
  thread: (appointmentId: string, occurrenceId?: string) =>
    occurrenceId
      ? ([...supportKeys.threads(), appointmentId, { occurrenceId }] as const)
      : ([...supportKeys.threads(), appointmentId] as const),
  requests: () => ["support", "requests"] as const,
  requestList: (
    userId: string | undefined,
    filters: { page: number; context?: string | null; status?: string | null },
  ) => [...supportKeys.requests(), userId, filters] as const,
  appointmentPicker: (userId: string | undefined) =>
    ["support", "appointment-picker", userId] as const,
  evidence: () => ["support", "evidence"] as const,
  evidenceList: (userId: string | undefined, organizationId?: string) =>
    [
      ...supportKeys.evidence(),
      "list",
      userId,
      organizationId ?? null,
    ] as const,
  evidenceRequest: (userId: string | undefined, requestId: string) =>
    [...supportKeys.evidence(), "request", userId, requestId] as const,
  inbox: () => ["support", "inbox"] as const,
  inboxList: (qs: string) => [...supportKeys.inbox(), "list", qs] as const,
  inboxStats: () => [...supportKeys.inbox(), "stats"] as const,
  operators: () => ["support", "operators"] as const,
  userSearch: (search: string) => ["support", "user-search", search] as const,
  org: () => ["support", "org"] as const,
  orgRequests: (orgId: string, page: number) =>
    [...supportKeys.org(), orgId, "requests", page] as const,
  orgThreads: (orgId: string, status: string) =>
    [...supportKeys.org(), orgId, "threads", status] as const,
  orgThreadCount: (orgId: string, status: string) =>
    [...supportKeys.org(), orgId, "thread-count", status] as const,
};

/** Refreshes one case's queries and every list or thread that can show it. */
export function invalidateSupportCase(qc: QueryClient, caseId: string) {
  return Promise.all(
    [
      supportKeys.case(caseId),
      supportKeys.threads(),
      supportKeys.requests(),
      supportKeys.evidence(),
      supportKeys.inbox(),
      supportKeys.org(),
    ].map((queryKey) => qc.invalidateQueries({ queryKey })),
  );
}
