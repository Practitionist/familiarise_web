import { z } from "zod";

import { EntityTraceView } from "@/components/dashboard/backoffice/EntityTraceView";
import { requireBackofficePage } from "@/lib/auth-guard";
import { can } from "@/lib/backoffice/capability";
import {
  readEntityTrace,
  readTraceCandidates,
} from "@/lib/backoffice/entity-trace";
import { TRACE_KINDS } from "@/lib/backoffice/entity-trace-types";

const TraceQuery = z.object({
  kind: z.enum(TRACE_KINDS),
  id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
});

type SearchParams = Record<string, string | string[] | undefined>;

/** Read-only entity trace, behind the same gate as the Payments money tab. */
export default async function BackofficeTracePage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ tree: string }>;
  searchParams: Promise<SearchParams>;
}>) {
  const { session, cap } = await requireBackofficePage(
    "payments.read",
    (await params).tree,
  );
  const sp = await searchParams;
  const first = (key: string) => {
    const value = sp[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const parsed = TraceQuery.safeParse({ kind: first("kind"), id: first("id") });
  if (!parsed.success) {
    // A refused id still fills the form, so the operator can correct it.
    return (
      <EntityTraceView
        mode="lookup"
        invalid={Boolean(first("id"))}
        kind={TraceQuery.shape.kind.safeParse(first("kind")).data}
        id={first("id")?.slice(0, 200)}
      />
    );
  }
  const { kind, id } = parsed.data;

  if (kind === "user") {
    const candidates = await readTraceCandidates(id);
    return candidates ? (
      <EntityTraceView mode="user" candidates={candidates} />
    ) : (
      <EntityTraceView mode="missing" kind={kind} id={id} />
    );
  }

  const seesSystemEvents = can(cap, "systemJobs.manage");
  const trace = await readEntityTrace({
    kind,
    id,
    viewer: { userId: session.user.id, role: cap.role, seesSystemEvents },
  });
  return trace ? (
    <EntityTraceView
      mode="trace"
      trace={trace}
      seesSystemEvents={seesSystemEvents}
    />
  ) : (
    <EntityTraceView mode="missing" kind={kind} id={id} />
  );
}
