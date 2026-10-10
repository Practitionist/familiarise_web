/**
 * @jest-environment node
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import * as Sentry from "@sentry/nextjs";

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
import type { PrismaLike } from "@/lib/prisma";
import {
  assertPublicUrl,
  resolvePublicUrl,
  SsrfBlockedError,
} from "@/lib/enterprise/outbound-webhooks/ssrf-guard";
import {
  DELIVERY_ID_HEADER,
  EVENT_HEADER,
  runDispatchTick,
} from "@/lib/enterprise/outbound-webhooks/worker";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { scrubUser } from "@/lib/compliance/erasure/scrub-user";

const FROZEN_NOW_MS = new Date("2026-06-01T12:00:00Z").getTime();

function makeDeliveryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "del-mega-1",
    webhookEndpointId: "ep-1",
    eventType: "invoice.issued",
    payload: { invoiceId: "inv-1" },
    signature: null,
    status: "PENDING",
    httpStatusCode: null,
    attempts: 0,
    nextRetryAt: null,
    lastError: null,
    createdAt: new Date("2026-06-01T10:00:00Z"),
    deliveredAt: null,
    endpoint: {
      id: "ep-1",
      url: "https://93.184.216.34/webhook",
      secret: "a".repeat(64),
      status: "ACTIVE",
      organizationId: "org-1",
      secretRotatedAt: null,
      previousSecretHash: null,
    },
    ...overrides,
  };
}

function makeWorkerPrisma(rows: Array<ReturnType<typeof makeDeliveryRow>>) {
  const deliveryUpdates: Array<Record<string, unknown>> = [];
  const endpointUpdates: Array<Record<string, unknown>> = [];
  const endpointUpdateManys: Array<Record<string, unknown>> = [];
  const auditLogs: Array<Record<string, unknown>> = [];

  return {
    prisma: {
      outboundWebhookDelivery: {
        findMany: jest.fn().mockResolvedValue(rows),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockImplementation((args) => {
          deliveryUpdates.push(args);
          return Promise.resolve({ id: args.where.id });
        }),
      },
      webhookEndpoint: {
        update: jest.fn().mockImplementation((args) => {
          endpointUpdates.push(args);
          return Promise.resolve({ id: args.where.id });
        }),
        updateMany: jest.fn().mockImplementation((args) => {
          endpointUpdateManys.push(args);
          return Promise.resolve({ count: 0 });
        }),
      },
      orgAuditLog: {
        create: jest.fn().mockImplementation((args) => {
          auditLogs.push(args);
          return Promise.resolve({ id: `audit-${auditLogs.length}` });
        }),
      },
    },
    deliveryUpdates,
    endpointUpdates,
    endpointUpdateManys,
    auditLogs,
  };
}

describe("SSRF guard IPv6 CIDR closures & resolvePublicUrl", () => {
  it.each([
    "http://93.184.216.34/hook",
    "https://93.184.216.34:8080/hook",
    "https://0.0.0.1/hook",
    "https://127.0.0.1/hook",
    "https://10.0.0.1/hook",
    "https://172.16.0.1/hook",
    "https://192.168.1.1/hook",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/hook",
    "https://[::ffff:127.0.0.1]/hook",
    "https://[::0.0.0.2]/hook",
    "https://[::0.255.255.255]/hook",
    "https://[64:ff9b:1::1]/hook",
    "https://[2001:0000:4136:e378:8000:63bf:3fff:fdd2]/hook",
    "https://[2001:db8::1]/hook",
    "https://[100::1]/hook",
    "https://[::1]/hook",
    "https://[fe80::1]/hook",
    "https://[fd00::1]/hook",
  ])("blocks non-public or invalid endpoint URL %s", async (url) => {
    await expect(assertPublicUrl(url)).rejects.toThrow(SsrfBlockedError);
    await expect(resolvePublicUrl(url)).rejects.toThrow(SsrfBlockedError);
  });

  it("resolves valid public IPv4, IPv6, and IPv4-mapped IPv6 literals with exact address and family", async () => {
    const v4 = await resolvePublicUrl("https://93.184.216.34/webhook");
    expect(v4).toMatchObject({
      address: "93.184.216.34",
      family: 4,
    });

    const v6 = await resolvePublicUrl(
      "https://[2606:2800:220:1:248:1893:25c8:1946]/webhook",
    );
    expect(v6).toMatchObject({
      address: "2606:2800:220:1:248:1893:25c8:1946",
      family: 6,
    });

    const mapped = await resolvePublicUrl(
      "https://[::ffff:93.184.216.34]/webhook",
    );
    expect(mapped).toMatchObject({
      address: "::ffff:5db8:d822",
      family: 6,
    });
  });
});

describe("Outbound webhook worker security, backoff, Sentry & OrgAuditLog", () => {
  it("pins production fetch via undici dispatcher, cancels response stream, and sends idempotency headers", async () => {
    const cancelMock = jest.fn().mockResolvedValue(undefined);
    const originalFetch = globalThis.fetch;
    let capturedInit: RequestInit & { dispatcher?: unknown } = {};

    globalThis.fetch = jest.fn(async (_input, init) => {
      capturedInit = (init ?? {}) as RequestInit & { dispatcher?: unknown };
      return {
        status: 200,
        body: { cancel: cancelMock },
      } as unknown as Response;
    }) as unknown as typeof fetch;

    try {
      const row = makeDeliveryRow({
        id: "del-pinned",
        eventType: "contract.signed",
      });
      const stub = makeWorkerPrisma([row]);

      const res = await runDispatchTick({
        prisma: stub.prisma as unknown as PrismaLike,
        now: () => FROZEN_NOW_MS,
      });

      expect(res.succeeded).toBe(1);
      expect(capturedInit.dispatcher).toBeDefined();
      expect(cancelMock).toHaveBeenCalledTimes(1);
      const headers = capturedInit.headers as Record<string, string>;
      expect(headers[DELIVERY_ID_HEADER]).toBe("del-pinned");
      expect(headers[EVENT_HEADER]).toBe("contract.signed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("records lastFailureAt without incrementing failureCount on transient 5xx, applies bounded jitter when clock is live, and does not write OrgAuditLog on RETRY", async () => {
    const row = makeDeliveryRow({ attempts: 0 });
    const stub = makeWorkerPrisma([row]);
    const fetchFn = jest.fn(
      async () => new Response("", { status: 502 }),
    ) as unknown as typeof fetch;

    const before = Date.now();
    const res = await runDispatchTick({
      prisma: stub.prisma as unknown as PrismaLike,
      fetchFn,
      assertUrlFn: async () => {},
    });
    const after = Date.now();

    expect(res.retried).toBe(1);
    expect(stub.auditLogs).toHaveLength(0);
    expect(stub.endpointUpdates).toHaveLength(1);
    expect(stub.endpointUpdates[0]).toMatchObject({
      where: { id: "ep-1" },
      data: { lastFailureAt: expect.any(Date) },
    });
    expect(stub.endpointUpdates[0].data).not.toHaveProperty("failureCount");

    const nextRetryAt = (
      stub.deliveryUpdates[0].data as { nextRetryAt: Date }
    ).nextRetryAt.getTime();
    // Base slot 1 is 60_000ms with jitter in [0.85, 1.15] -> [51_000ms, 69_000ms].
    expect(nextRetryAt).toBeGreaterThanOrEqual(before + 51_000);
    expect(nextRetryAt).toBeLessThanOrEqual(after + 69_000);
  });

  it("aggregates multiple dead-lettered rows into a single Sentry event and logs OrgAuditLog for terminal failures & auto-disable", async () => {
    (Sentry.captureException as jest.Mock).mockClear();

    const rows = [
      makeDeliveryRow({ id: "dl-1", attempts: 4 }),
      makeDeliveryRow({ id: "dl-2", attempts: 4 }),
      makeDeliveryRow({ id: "perm-400", attempts: 0 }),
    ];
    const stub = makeWorkerPrisma(rows);
    // Simulate auto-disable crossing threshold on the first terminal failure
    stub.prisma.webhookEndpoint.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValue({ count: 0 });

    const fetchFn = jest.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers[DELIVERY_ID_HEADER] === "perm-400") {
        return new Response("bad", { status: 400 });
      }
      return new Response("err", { status: 503 });
    }) as unknown as typeof fetch;

    const res = await runDispatchTick({
      prisma: stub.prisma as unknown as PrismaLike,
      fetchFn,
      assertUrlFn: async () => {},
      now: () => FROZEN_NOW_MS,
    });

    expect(res.failed).toBe(3);
    // Two dead-letter rows MUST emit only ONE aggregated Sentry capture per tick
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    // 3 terminal deliveries + 1 auto-disable = 4 OrgAuditLog entries with WEBHOOK_DELIVERY_FAILED
    expect(stub.auditLogs).toHaveLength(4);
    for (const log of stub.auditLogs) {
      expect(log.data).toMatchObject({
        category: "WEBHOOK",
        action: AUDIT_ACTIONS.WEBHOOK.WEBHOOK_DELIVERY_FAILED,
      });
    }
  });

  it("caps dispatch-outbound-webhooks batch limit at 15 in Netlify cron-tick", () => {
    const cronTickSrc = readFileSync(
      path.resolve(process.cwd(), "netlify/functions/cron-tick.mts"),
      "utf8",
    );
    expect(cronTickSrc).toContain('"dispatch-outbound-webhooks": 15');
  });

  it("includes role and previousStatus on DPDP scrubUser member.removed webhook payload", async () => {
    const dispatched: Array<Record<string, unknown>> = [];
    const txStub = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ consultantProfileId: null }),
        update: jest.fn().mockResolvedValue({}),
      },
      membership: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      programAssignment: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      payoutAccount: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      consultantProfile: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      consulteeProfile: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      trial: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      consultation: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      collaborator: { findMany: jest.fn().mockResolvedValue([]) },
      erasureRequest: { findFirst: jest.fn().mockResolvedValue(null) },
      session: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      account: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      consentArtifact: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      orgAuditLog: { create: jest.fn().mockResolvedValue({}) },
      webhookEndpoint: {
        findMany: jest.fn().mockResolvedValue([{ id: "ep-1" }]),
      },
      outboundWebhookDelivery: {
        createMany: jest.fn().mockImplementation((args) => {
          dispatched.push(...args.data);
          return Promise.resolve({ count: args.data.length });
        }),
      },
    };
    const dbStub = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: "u-erase",
          erasedAt: null,
          pseudonymousId: null,
          razorpayCustomerId: null,
        }),
      },
      membership: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "mem-erase-1",
            organizationId: "org-1",
            role: "EXPERT",
            status: "ACTIVE",
          },
        ]),
      },
      payoutAccount: { findMany: jest.fn().mockResolvedValue([]) },
      recording: { findMany: jest.fn().mockResolvedValue([]) },
      recordingConsent: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
        fn(txStub),
      ),
    };

    await scrubUser(dbStub as never, "u-erase");

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      eventType: "member.removed",
      payload: expect.objectContaining({
        membershipId: "mem-erase-1",
        role: "EXPERT",
        previousStatus: "ACTIVE",
        source: "dpdp_erasure",
      }),
    });
  });
});
