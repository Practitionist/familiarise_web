/**
 * @jest-environment node
 */

/**
 * Request-level idempotency for money mutations (lib/api/idempotency.ts).
 *
 * The gateway headers (X-Refund-Idempotency, X-Payout-Idempotency) are keyed
 * off rows we create first, so a duplicate REQUEST still mints a second row
 * with a second gateway key and the gateway honours both. These assert the
 * layer that stops the duplicate one step earlier.
 */

const store = new Map<string, Record<string, unknown>>();
const keyOf = (w: {
  scope_key_userId: { scope: string; key: string; userId: string };
}) =>
  `${w.scope_key_userId.scope}|${w.scope_key_userId.key}|${w.scope_key_userId.userId}`;

const sameValue = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date
    ? a.getTime() === b.getTime()
    : a === b;
/** The stored row a flat compare-and-set `where` matches on every field, if any. */
function matchingKey(where: Record<string, unknown>): string | null {
  const k = `${where.scope}|${where.key}|${where.userId}`;
  const row = store.get(k);
  if (!row) return null;
  return Object.entries(where).every(([field, value]) =>
    sameValue(row[field], value),
  )
    ? k
    : null;
}

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    idempotencyRecord: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const k = `${data.scope}|${data.key}|${data.userId}`;
        if (store.has(k)) {
          throw Object.assign(new Error("Unique constraint failed"), {
            code: "P2002",
          });
        }
        store.set(k, { ...data, completedAt: null });
        return store.get(k);
      }),
      findUnique: jest.fn(
        async ({ where }: { where: never }) => store.get(keyOf(where)) ?? null,
      ),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: never;
          data: Record<string, unknown>;
        }) => {
          const k = keyOf(where);
          store.set(k, { ...(store.get(k) ?? {}), ...data });
          return store.get(k);
        },
      ),
      delete: jest.fn(async ({ where }: { where: never }) => {
        store.delete(keyOf(where));
        return {};
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const k = matchingKey(where);
          if (!k) return { count: 0 };
          store.set(k, { ...store.get(k), ...data });
          return { count: 1 };
        },
      ),
      deleteMany: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          const k = matchingKey(where);
          if (k) store.delete(k);
          return { count: k ? 1 : 0 };
        },
      ),
    },
  },
}));

import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { withIdempotency } from "../../lib/api/idempotency";

function req(body: unknown, key?: string): NextRequest {
  return new NextRequest("https://x.test/api/admin/refunds", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
}

const OPTS = { scope: "admin.refund", userId: "user_1" };
const KEY = "idem-key-0000001";

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
});

describe("withIdempotency", () => {
  it("runs the handler unchanged when no key is supplied", async () => {
    const handler = jest.fn(async () => NextResponse.json({ ok: true }));

    await withIdempotency(req({ a: 1 }), OPTS, handler);
    await withIdempotency(req({ a: 1 }), OPTS, handler);

    // No key means no dedupe — existing clients must not change behaviour.
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("runs the handler exactly once for a repeated key and replays the response", async () => {
    const handler = jest.fn(async () =>
      NextResponse.json({ refundId: "rf_1" }, { status: 201 }),
    );

    const first = await withIdempotency(req({ a: 1 }, KEY), OPTS, handler);
    const second = await withIdempotency(req({ a: 1 }, KEY), OPTS, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual({ refundId: "rf_1" });
    expect(second.headers.get("Idempotent-Replay")).toBe("true");
  });

  it("rejects the same key used with a different body", async () => {
    const handler = jest.fn(async () => NextResponse.json({ ok: true }));

    await withIdempotency(req({ amountPaise: 100 }, KEY), OPTS, handler);
    const clash = await withIdempotency(
      req({ amountPaise: 999999 }, KEY),
      OPTS,
      handler,
    );

    // Replaying the first response here would tell the caller their ₹9,999.99
    // refund succeeded when a ₹1.00 one did.
    expect(clash.status).toBe(422);
    expect((await clash.json()).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("isolates keys by scope and by user", async () => {
    const handler = jest.fn(async () => NextResponse.json({ ok: true }));

    await withIdempotency(req({ a: 1 }, KEY), OPTS, handler);
    await withIdempotency(
      req({ a: 1 }, KEY),
      { scope: "org.payout.create", userId: "user_1" },
      handler,
    );
    await withIdempotency(
      req({ a: 1 }, KEY),
      { scope: "admin.refund", userId: "user_2" },
      handler,
    );

    // One key reused across two operations, or by two users, must not replay.
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("frees the key when the handler returns a failure, so the caller can retry", async () => {
    const handler = jest
      .fn()
      .mockResolvedValueOnce(
        NextResponse.json({ error: "gateway down" }, { status: 502 }),
      )
      .mockResolvedValueOnce(NextResponse.json({ refundId: "rf_2" }));

    const failed = await withIdempotency(req({ a: 1 }, KEY), OPTS, handler);
    expect(failed.status).toBe(502);

    const retried = await withIdempotency(req({ a: 1 }, KEY), OPTS, handler);
    expect(retried.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("409s a concurrent duplicate while the first request is still in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const handler = jest.fn(async () => {
      await gate;
      return NextResponse.json({ refundId: "rf_3" });
    });

    const inFlight = withIdempotency(req({ a: 1 }, KEY), OPTS, handler);
    // Second request arrives before the first completes.
    const concurrent = await withIdempotency(req({ a: 1 }, KEY), OPTS, handler);

    expect(concurrent.status).toBe(409);
    expect((await concurrent.json()).code).toBe("IDEMPOTENCY_IN_FLIGHT");

    release();
    await inFlight;
    expect(handler).toHaveBeenCalledTimes(1);
  });

  describe("a claim is taken, completed and freed only by its own holder", () => {
    const STORE_KEY = `${OPTS.scope}|${KEY}|${OPTS.userId}`;
    const bodyHash = (body: unknown) =>
      createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const p2002 = () =>
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    const records = (
      jest.requireMock("../../lib/prisma") as {
        default: {
          idempotencyRecord: { create: jest.Mock; findUnique: jest.Mock };
        };
      }
    ).default.idempotencyRecord;

    it("two retries that read one expired claim: one takes it over and runs, the other is told it is in flight", async () => {
      const expired = {
        ...OPTS,
        key: KEY,
        requestHash: bodyHash({ a: 1 }),
        completedAt: new Date("2020-01-01T00:00:00.000Z"),
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
        expiresAt: new Date("2020-01-02T00:00:00.000Z"),
      };
      store.set(STORE_KEY, expired);
      // Both retries read the expired row before either writes.
      records.findUnique
        .mockResolvedValueOnce({ ...expired })
        .mockResolvedValueOnce({ ...expired });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const handler = jest.fn(async () => {
        await gate;
        return NextResponse.json({ moved: true });
      });

      const racing = Promise.all([
        withIdempotency(req({ a: 1 }, KEY), OPTS, handler),
        withIdempotency(req({ a: 1 }, KEY), OPTS, handler),
      ]);
      await new Promise((r) => setTimeout(r, 0));
      release();
      const statuses = (await racing).map((r) => r.status).sort();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(statuses).toEqual([200, 409]);
    });

    it("a handler that finishes after its claim passed to a newer request neither overwrites nor deletes the newer receipt", async () => {
      const newer = {
        ...OPTS,
        key: KEY,
        requestHash: bodyHash({ a: 2 }),
        completedAt: new Date(),
        createdAt: new Date(Date.now() + 5_000),
        expiresAt: new Date(Date.now() + 86_400_000),
        responseStatus: 200,
        responseBody: { from: "newer" },
      };
      for (const late of [
        async () => NextResponse.json({ from: "older" }),
        async () => {
          throw new Error("late failure");
        },
        async () => NextResponse.json({ error: "late" }, { status: 409 }),
      ]) {
        store.clear();
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const older = withIdempotency(req({ a: 1 }, KEY), OPTS, async () => {
          await gate;
          return late();
        }).catch(() => null);
        await new Promise((r) => setTimeout(r, 0));
        // The older claim lapsed and a newer request holds the key now.
        store.set(STORE_KEY, { ...newer });
        release();
        await older;

        expect(store.get(STORE_KEY)).toEqual(newer);
      }
    });

    it("a claim that vanishes between the refused insert and the read is claimed again, never run unclaimed", async () => {
      records.create.mockRejectedValueOnce(p2002());
      const handler = jest.fn(async () => NextResponse.json({ moved: true }));

      const first = await withIdempotency(req({ a: 1 }, KEY), OPTS, handler);
      const retry = await withIdempotency(req({ a: 1 }, KEY), OPTS, handler);

      expect(first.status).toBe(200);
      expect(retry.headers.get("Idempotent-Replay")).toBe("true");
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("a claim that keeps vanishing answers in-flight instead of running unclaimed", async () => {
      records.create
        .mockRejectedValueOnce(p2002())
        .mockRejectedValueOnce(p2002());
      const handler = jest.fn(async () => NextResponse.json({ moved: true }));

      const res = await withIdempotency(req({ a: 1 }, KEY), OPTS, handler);

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("IDEMPOTENCY_IN_FLIGHT");
      expect(handler).not.toHaveBeenCalled();
    });
  });

  it("rejects a key shorter than the gateway minimum", async () => {
    const handler = jest.fn(async () => NextResponse.json({ ok: true }));

    const res = await withIdempotency(req({ a: 1 }, "short"), OPTS, handler);

    expect(res.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });
});
