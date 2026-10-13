import type { QueryClient } from "@tanstack/react-query";

/** One key factory for document, recording and material reads, so every mutation invalidates the same set. */
export const documentKeys = {
  all: ["documents"] as const,
  workspace: (appointmentId: string) =>
    ["documents", "workspace", appointmentId] as const,
  library: () => ["documents", "library"] as const,
};

export const recordingKeys = {
  all: ["recordings"] as const,
  appointment: (appointmentId: string) =>
    ["recordings", "appointment", appointmentId] as const,
  library: () => ["recordings", "library"] as const,
};

/** A Library list's key base; LibraryBrowser appends the read's query string. */
export const libraryKeys = {
  personal: (
    artifact: "documents" | "recordings",
    tree: "consultee" | "consultant",
    profileId: string,
  ) =>
    [
      ...(artifact === "documents"
        ? documentKeys.library()
        : recordingKeys.library()),
      tree,
      profileId,
    ] as const,
  org: (
    orgId: string,
    artifact: "documents" | "recordings",
    scope: "mine" | "everyone",
  ) => ["org-library", orgId, artifact, scope] as const,
};

export const materialKeys = {
  appointment: (appointmentId: string) =>
    ["materials", "appointment", appointmentId] as const,
  offering: (type: string, planId: string) =>
    ["offering-materials", type, planId] as const,
};

/** After any document change: the workspace, every library page and the booking hub. */
export function invalidateDocumentReads(
  queryClient: QueryClient,
  appointmentId: string,
): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: documentKeys.workspace(appointmentId),
    }),
    queryClient.invalidateQueries({ queryKey: documentKeys.library() }),
    queryClient.invalidateQueries({
      queryKey: ["appointment-detail", appointmentId],
    }),
  ]).then(() => undefined);
}
