import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import {
  INCIDENTS_PAGE_SIZE,
  readIncidentSuggestions,
  readIncidents,
} from "@/lib/backoffice/incidents-read";
import {
  declareIncident,
  incidentWindowSchema,
} from "@/lib/booking/platform-incidents";

/** The Incidents tab: declared incidents with remedy counts, and the read-only suggestions. */
export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("incidents.read");
  if (auth.error) return auth.error;
  const page = z.coerce
    .number()
    .int()
    .positive()
    .max(10_000)
    .catch(1)
    .parse(req.nextUrl.searchParams.get("page") ?? undefined);
  const { rows, total } = await readIncidents(page);
  const suggestions = await readIncidentSuggestions();
  return NextResponse.json(
    {
      incidents: rows,
      total,
      page,
      pageSize: INCIDENTS_PAGE_SIZE,
      suggestions,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const isoDateTime = z.string().datetime({ offset: true });

/** Declares one incident window; the same window again returns the first incident. */
export const POST = withOpsAction(
  "incidents.declare",
  "incident.declare",
  { startsAt: isoDateTime, endsAt: isoDateTime },
  {
    mode: "tx",
    run: async (tx, { body, actor }) => {
      const parsed = incidentWindowSchema(new Date()).safeParse(body);
      if (!parsed.success) {
        throw new OpsRefusal(
          "INVALID_WINDOW",
          parsed.error.issues[0]?.message ?? "Invalid incident window.",
          400,
        );
      }
      const incident = await declareIncident(tx, {
        ...parsed.data,
        reason: body.reason,
        declaredByUserId: actor.userId,
      });
      return {
        target: { kind: "PlatformIncident", id: incident.id },
        correlationId: `incident:${incident.id}`,
        after: {
          startsAt: parsed.data.startsAt.toISOString(),
          endsAt: parsed.data.endsAt.toISOString(),
          created: incident.created,
        },
        response: { incidentId: incident.id, created: incident.created },
        status: incident.created ? 201 : 200,
      };
    },
  },
  { stepUp: true },
);
