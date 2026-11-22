/**
 * @jest-environment node
 */

// Stream subscribes to `call.stats_report_ready` but documents the payload
// `type` as `call.report_ready`; both are stored and handled as the one event.
import {
  canonicalStreamEventType,
  DESIRED_EVENT_TYPES,
} from "@/lib/stream/webhook-events";
import { STREAM_EVENT_SCHEMAS } from "@/schemas/webhooks/stream";

it.each(["call.stats_report_ready", "call.report_ready"])(
  "a delivery typed %s is the subscribed report-ready event and keeps its session id",
  (type) => {
    expect(canonicalStreamEventType(type)).toBe("call.stats_report_ready");
    expect(
      STREAM_EVENT_SCHEMAS["call.stats_report_ready"].parse({
        type,
        call_cid: "default:occurrence-1",
        created_at: "2026-11-23T06:00:00.000Z",
        session_id: "B",
        counts: { participants: 2 },
      }),
    ).toEqual({
      type,
      call_cid: "default:occurrence-1",
      created_at: "2026-11-23T06:00:00.000Z",
      session_id: "B",
    });
  },
);

it("subscribes to the report-ready event and leaves other types as they are", () => {
  expect(DESIRED_EVENT_TYPES).toContain("call.stats_report_ready");
  expect(canonicalStreamEventType("call.ended")).toBe("call.ended");
});
