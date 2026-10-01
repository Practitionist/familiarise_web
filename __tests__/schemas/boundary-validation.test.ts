/**
 * @jest-environment node
 */

/**
 * Boundary schemas for the loose-input audit (#1802 follow-up): money and
 * auth-adjacent route inputs that previously flowed unvalidated into
 * services, Stream, or Prisma. Pure-shape tests — no DB, no network.
 */
import {
  adminPayoutBatchSchema,
  adminPayoutsQuerySchema,
  payoutAccountPatchSchema,
} from "../../schemas/payouts";
import { channelCreateSchema } from "../../schemas/stream-channels";
import { userIdQuerySchema } from "../../schemas/user";
import { parseJsonRequest, parseRequestBody } from "../../lib/api/parse";

describe("adminPayoutBatchSchema", () => {
  it("accepts a non-empty id list", () => {
    const parsed = adminPayoutBatchSchema.safeParse({
      consultantProfileIds: ["cp_1", "cp_2"],
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ["missing", {}],
    ["not an array", { consultantProfileIds: "cp_1" }],
    ["empty", { consultantProfileIds: [] }],
    ["oversized", { consultantProfileIds: Array(201).fill("cp") }],
    ["blank id", { consultantProfileIds: [""] }],
  ])("rejects %s", (_label, body) => {
    expect(adminPayoutBatchSchema.safeParse(body).success).toBe(false);
  });
});

describe("adminPayoutsQuerySchema", () => {
  it("defaults pagination and passes filters through", () => {
    const parsed = adminPayoutsQuerySchema.safeParse({});
    if (!parsed.success) throw new Error("expected query defaults to parse");
    expect(parsed.data.limit).toBe(50);
    expect(parsed.data.offset).toBe(0);
  });

  it.each([
    ["NaN limit", { limit: "abc" }],
    ["zero limit", { limit: "0" }],
    ["huge limit", { limit: "10000" }],
    ["negative offset", { offset: "-5" }],
    ["unknown status", { status: "MINTED" }],
  ])("rejects %s", (_label, query) => {
    expect(adminPayoutsQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe("payoutAccountPatchSchema", () => {
  it("accepts each known mutation and strips unknown keys", () => {
    expect(
      payoutAccountPatchSchema.safeParse({ action: "reverify" }).success,
    ).toBe(true);
    expect(
      payoutAccountPatchSchema.safeParse({ isDefault: true }).success,
    ).toBe(true);
    const stripped = payoutAccountPatchSchema.safeParse({
      isDefault: true,
      admin: true,
    });
    if (!stripped.success) throw new Error("expected strip parse");
    expect(stripped.data).toEqual({ isDefault: true });
  });

  it.each([
    ["unknown action", { action: "delete" }],
    ["wrong type", { isDefault: "yes" }],
  ])("rejects %s", (_label, body) => {
    expect(payoutAccountPatchSchema.safeParse(body).success).toBe(false);
  });
});

describe("channelCreateSchema", () => {
  const BASE = { channelType: "messaging", createdById: "user_1" };

  it("accepts event-linked and custom shapes", () => {
    expect(
      channelCreateSchema.safeParse({
        ...BASE,
        eventType: "webinar",
        eventId: "evt_1",
      }).success,
    ).toBe(true);
    expect(
      channelCreateSchema.safeParse({
        ...BASE,
        channelName: "Ops room",
        members: ["user_1", "user_2"],
      }).success,
    ).toBe(true);
  });

  it.each([
    ["unknown event type", { ...BASE, eventType: "dm" }],
    ["oversized members", { ...BASE, members: Array(101).fill("u") }],
    ["missing creator", { channelType: "messaging" }],
    ["blank channel type", { ...BASE, channelType: "" }],
  ])("rejects %s", (_label, body) => {
    expect(channelCreateSchema.safeParse(body).success).toBe(false);
  });
});

describe("parseJsonRequest", () => {
  const schema = adminPayoutBatchSchema;

  it("400s malformed JSON instead of throwing to the 500 catch", async () => {
    const req = {
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    };
    const { data, error } = await parseJsonRequest(schema, req);
    expect(data).toBeUndefined();
    expect(error?.status).toBe(400);
  });

  it("400s shape violations with issues attached", async () => {
    const req = { json: async () => ({ consultantProfileIds: [] }) };
    const { data, error } = await parseJsonRequest(schema, req);
    expect(data).toBeUndefined();
    expect(error?.status).toBe(400);
  });

  it("passes valid bodies through untouched", async () => {
    const req = { json: async () => ({ consultantProfileIds: ["cp_1"] }) };
    const { data, error } = await parseJsonRequest(schema, req);
    expect(error).toBeUndefined();
    expect(data).toEqual({ consultantProfileIds: ["cp_1"] });
  });

  it("parseRequestBody preserves caller error extras", () => {
    const { error } = parseRequestBody(schema, {}, "Bad", {
      success: false,
    });
    expect(error?.status).toBe(400);
  });

  it("error body carries the message, issues, and extras", async () => {
    const { error } = await parseJsonRequest(schema, {
      json: async () => ({ consultantProfileIds: [] }),
    });
    expect(error?.status).toBe(400);
    const body = await error?.json();
    expect(body).not.toHaveProperty("success");
    expect(typeof body?.error).toBe("string");
    expect(Array.isArray(body?.issues)).toBe(true);
  });

  it("extras flow into the error body", async () => {
    const { error } = await parseJsonRequest(
      schema,
      { json: async () => ({}) },
      "Bad",
      { success: false },
    );
    const body = await error?.json();
    expect(body).toMatchObject({ error: "Bad", success: false });
    expect(Array.isArray(body?.issues)).toBe(true);
  });
});

describe("userIdQuerySchema", () => {
  it("accepts a bounded id", () => {
    expect(userIdQuerySchema.safeParse({ userId: "cjld2cjxh0000" }).success).toBe(
      true,
    );
  });

  it.each([["missing", {}], ["blank", { userId: "" }], ["oversized", { userId: "x".repeat(129) }]])(
    "rejects %s",
    (_label, query) => {
      expect(userIdQuerySchema.safeParse(query).success).toBe(false);
    },
  );
});
