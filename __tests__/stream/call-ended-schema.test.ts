/**
 * @jest-environment node
 */
import { STREAM_EVENT_SCHEMAS } from "../../schemas/webhooks/stream";

const base = {
  type: "call.ended",
  call_cid: "default:occurrence-abc",
  created_at: "2026-10-25T04:30:00.000Z",
};

describe("call.ended webhook schema", () => {
  it("accepts a call ended without an acting user (Stream sends user: null)", () => {
    const parsed = STREAM_EVENT_SCHEMAS["call.ended"].safeParse({
      ...base,
      user: null,
      reason: null,
      ended_by_user_id: null,
      call: { id: "occurrence-abc", type: "default", ended_by_user_id: null },
    });
    expect(parsed.success).toBe(true);
  });

  it("still accepts a host-ended call with the acting user", () => {
    const parsed = STREAM_EVENT_SCHEMAS["call.ended"].safeParse({
      ...base,
      user: { id: "host-1" },
      call: { id: "occurrence-abc", type: "default" },
    });
    expect(parsed.success).toBe(true);
  });

  it("still rejects a user object without an id", () => {
    const parsed = STREAM_EVENT_SCHEMAS["call.ended"].safeParse({
      ...base,
      user: {},
    });
    expect(parsed.success).toBe(false);
  });
});
