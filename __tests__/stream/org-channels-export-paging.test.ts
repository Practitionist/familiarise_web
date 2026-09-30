/**
 * @jest-environment node
 */

/**
 * #E7 — the org chat-channel export paged over a MOVING sort.
 *
 * `GET /api/organizations/[orgId]/stream/channels` is a COMPLIANCE surface: it
 * writes a `STREAM_CHANNELS_EXPORTED` audit row and is the documented companion
 * of `/stream/calls`, so "what this org's roster of internal channels was" is a
 * fact someone may later be asked to attest to. Two defects made that
 * attestation unsound:
 *
 *   - It sorted on `last_message_at`, which MOVES during an offset walk. A
 *     message arriving mid-walk promotes its channel past the current offset,
 *     pushing everything between the old and new position off the end — i.e.
 *     SKIPPING channels — while a channel moving the other way can be returned
 *     twice. An export that skips and repeats is worse than one that stops
 *     early, because nothing downstream can tell.
 *   - `hasMore` was "this page came back full", which conflates "there is more"
 *     with "there might be more, and we will not find out past Stream's
 *     1000-offset ceiling". A large org silently got a short list presented as
 *     complete.
 *
 * The route is asserted here at the ROUTE level rather than by booting Next, so
 * the sort key and the truncation flag are pinned without a request harness.
 */

const queryChannels = jest.fn();
const auditCreate = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    orgAuditLog: { create: (...args: unknown[]) => auditCreate(...args) },
  },
}));

jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: () => ({ queryChannels }),
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(async () => ({ member: { id: "member-1" } })),
}));

import { GET } from "../../app/api/organizations/[orgId]/stream/channels/route";
import { STREAM_QUERY_CHANNELS_MAX_OFFSET } from "../../lib/stream/batch";

const PAGE_SIZE = 20;
const MAX_PAGE = 50;
const params = { params: Promise.resolve({ orgId: "org-1" }) };

// The route's signature is `NextRequest`; only `url` is read here, so a plain
// `Request` is cast once at the boundary rather than constructing a NextRequest
// in every case.
const req = (page: number) =>
  new Request(
    `https://x.test/api/organizations/org-1/stream/channels?page=${page}`,
  ) as unknown as import("next/server").NextRequest;

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    cid: `messaging:ch-${i}`,
    id: `ch-${i}`,
    type: "messaging",
    data: { name: `c${i}`, member_count: 2, last_message_at: null },
  }));

beforeEach(() => {
  jest.clearAllMocks();
  queryChannels.mockResolvedValue([]);
  auditCreate.mockResolvedValue({});
});

describe("GET org stream channels — stable ordering (#E7)", () => {
  it("sorts on created_at, never on last_message_at", async () => {
    // The whole defect. `last_message_at` is the field Stream defaults to and
    // the one `action-channel.action.ts` already replaced for exactly this
    // reason; a channel's creation time never changes, which is the only
    // property that makes offset paging coherent at all.
    queryChannels.mockResolvedValue(rows(1));

    await GET(req(1), params);

    const [, sort] = queryChannels.mock.calls[0];
    expect(sort).toEqual([{ created_at: 1 }]);
    expect(JSON.stringify(sort)).not.toContain("last_message_at");
  });

  it("filters on the org tag, not on membership", async () => {
    queryChannels.mockResolvedValue(rows(1));

    await GET(req(1), params);

    const [filter] = queryChannels.mock.calls[0];
    expect(filter).toEqual({ organization_id: { $eq: "org-1" } });
  });

  it("still asks for metadata only — no messages, no full rosters", async () => {
    // Unchanged, and asserted because a compliance export must not become a
    // content read: ADR 20 puts session content with the participants.
    queryChannels.mockResolvedValue(rows(1));

    await GET(req(1), params);

    const [, , args] = queryChannels.mock.calls[0];
    expect(args).toMatchObject({
      message_limit: 0,
      member_limit: 0,
      limit: PAGE_SIZE,
      offset: 0,
    });
  });
});

describe("GET org stream channels — the truncation flag (#E7)", () => {
  it("says truncated at Stream's offset ceiling and stops claiming hasMore", async () => {
    // A full page at the LAST reachable page. The old code answered
    // `hasMore: true`, which told the client to fetch a page Stream will not
    // serve — and told an auditor the list was complete when it was a prefix.
    queryChannels.mockResolvedValue(rows(PAGE_SIZE));

    const body = await (await GET(req(MAX_PAGE), params)).json();

    expect(body.truncated).toBe(true);
    expect(body.hasMore).toBe(false);
    expect(body.rows).toHaveLength(PAGE_SIZE);
  });

  it("does not claim truncation anywhere below the ceiling", async () => {
    queryChannels.mockResolvedValue(rows(PAGE_SIZE));

    const body = await (await GET(req(1), params)).json();

    // A full page here really does mean "ask for the next one".
    expect(body.truncated).toBe(false);
    expect(body.hasMore).toBe(true);
  });

  it("treats a short page as the end, with no truncated flag", async () => {
    queryChannels.mockResolvedValue(rows(3));

    const body = await (await GET(req(1), params)).json();

    expect(body.truncated).toBe(false);
    expect(body.hasMore).toBe(false);
  });

  it("puts the flag in the AUDIT row, not just the response", async () => {
    // The response is read by the operator; the audit row is read later by
    // whoever asks what was exported and when. A partial export recorded as a
    // complete one is the shape of a misstatement, so the flag has to travel
    // with the record.
    queryChannels.mockResolvedValue(rows(PAGE_SIZE));

    await GET(req(MAX_PAGE), params);

    expect(auditCreate).toHaveBeenCalledTimes(1);
    const { data } = auditCreate.mock.calls[0][0];
    expect(data.details).toMatchObject({ truncated: true, page: MAX_PAGE });
  });

  it("keeps the page ceiling at Stream's offset ceiling", async () => {
    // 50 pages x 20 = 1,000 = `STREAM_QUERY_CHANNELS_MAX_OFFSET`. The two must
    // not drift apart: a ceiling BELOW Stream's would silently truncate, and one
    // ABOVE it would ask for offsets Stream refuses to serve.
    const { GET: getRoute } =
      await import("../../app/api/organizations/[orgId]/stream/channels/route");
    expect(getRoute).toBe(GET);
    expect(MAX_PAGE * PAGE_SIZE).toBe(STREAM_QUERY_CHANNELS_MAX_OFFSET);
  });
});
