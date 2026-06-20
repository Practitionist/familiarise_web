/**
 * GET /api/organizations/[orgId]/stream/channels
 *
 * Lists Stream Chat channels tagged with `custom.organization_id = <orgId>`.
 * Surfaces the messaging side of an org's footprint to MANAGER+ org workspace operators
 * for compliance, member-management, and audit workflows. Backed by Stream's
 * native `queryChannels` so we don't shadow channel state in our DB.
 *
 * AUTH: MANAGER+ on the target org (matches the rest of the org-workspace
 * surface area; viewing chat metadata is on par with viewing audit logs).
 *
 * PAGINATION: Stream caps `queryChannels` at 30 per call; we ship 20/page
 * with offset-based pagination to keep the URL simple. `?page=` is 1-based.
 *
 * RESPONSE: minimal shape so the client can render a directory table
 * without fetching messages.
 *
 * TODO: Equivalent `/stream/calls` endpoint for video. Stream Video's
 * `queryCalls` API is custom-field filterable but uses a different SDK
 * surface (`@stream-io/node-sdk`) and slightly different filter syntax;
 * deferring to a follow-up issue.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { getStreamChatClient } from "@/lib/stream-client";
import { streamLogger } from "@/lib/stream-logger";

const QuerySchema = z.object({
  // 1-based page number; offset is computed server-side. Capped at a
  // generous 50 (~1000 channels) to keep Stream's pagination from
  // degrading; orgs above that should use search/filter UI.
  page: z.coerce.number().int().min(1).max(50).default(1),
});

const PAGE_SIZE = 20;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { page } = parsed.data;
  const offset = (page - 1) * PAGE_SIZE;

  try {
    const client = getStreamChatClient();
    // Stream's filter language: top-level keys map to channel custom data
    // when prefixed (or matched implicitly via custom_field_name). Since
    // our helper writes `organization_id` at the top level of channel
    // custom data, the equality match below is the canonical form.
    const channels = await client.queryChannels(
      // Cast through unknown — stream-chat's `ChannelFilters` typing is
      // strict about known fields and rejects custom keys, but the
      // server accepts arbitrary custom-data filters at runtime.
      { organization_id: { $eq: orgId } } as unknown as Parameters<
        typeof client.queryChannels
      >[0],
      [{ last_message_at: -1 }],
      {
        limit: PAGE_SIZE,
        offset,
        // Don't fetch messages — we only need metadata for the list.
        message_limit: 0,
        // Don't fetch full member rosters; member_count is enough.
        member_limit: 0,
      },
    );

    const rows = channels.map((ch) => {
      const data = ch.data as Record<string, unknown> | undefined;
      const lastMessageAt = data?.last_message_at;
      return {
        cid: ch.cid,
        id: ch.id,
        type: ch.type,
        name: typeof data?.name === "string" ? (data.name as string) : null,
        memberCount:
          typeof data?.member_count === "number"
            ? (data.member_count as number)
            : null,
        lastMessageAt:
          typeof lastMessageAt === "string"
            ? lastMessageAt
            : lastMessageAt instanceof Date
              ? lastMessageAt.toISOString()
              : null,
      };
    });

    return NextResponse.json({
      page,
      pageSize: PAGE_SIZE,
      // `hasMore` is best-effort — Stream doesn't return a total count.
      // If we got a full page back, assume another exists.
      hasMore: rows.length === PAGE_SIZE,
      rows,
    });
  } catch (err) {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    streamLogger.error("Failed to query org channels", err, { orgId, page });
    return NextResponse.json(
      {
        error: "Failed to query channels",
        detail: err instanceof Error ? err.message : "unknown",
      },
      { status: 502 },
    );
  }
}
