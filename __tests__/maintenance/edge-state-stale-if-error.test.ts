/**
 * @jest-environment node
 */

// Invariant: a slow or failed Upstash read keeps serving the last confirmed maintenance
// state for 15 minutes; only an isolate that never read the state fails closed.

import type { MaintenanceState } from "@/lib/maintenance-edge";

type Edge = typeof import("@/lib/maintenance-edge");

function loadFresh(): Edge {
  let mod: Edge | undefined;
  jest.isolateModules(() => {
    mod = jest.requireActual<Edge>("../../lib/maintenance-edge");
  });
  if (!mod) throw new Error("module did not load");
  return mod;
}

function okResponse(result: string | null): Response {
  return new Response(JSON.stringify({ result }), { status: 200 });
}

const env = { ...process.env };
let nowMs = 1_000_000;

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.example";
  process.env.UPSTASH_REDIS_REST_TOKEN = "token";
  nowMs = 1_000_000;
  jest.spyOn(Date, "now").mockImplementation(() => nowMs);
});

afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...env };
});

const OFF: MaintenanceState = {
  phase: "OFF",
  reason: null,
  estimatedEnd: null,
  bypassSecret: null,
};

it("serves the last confirmed state when a later read fails", async () => {
  const edge = loadFresh();
  const fetchSpy = jest
    .spyOn(global, "fetch")
    .mockImplementation(async () => okResponse("OFF"));
  await expect(edge.getMaintenanceState()).resolves.toEqual(OFF);

  // Past the 3-minute cache, Upstash times out on the read and on its one retry.
  nowMs += 4 * 60_000;
  fetchSpy.mockRejectedValue(new Error("The operation was aborted"));
  const state = await edge.getMaintenanceState();
  expect(state).toEqual(OFF);
  expect(state.unreadable).toBeUndefined();
});

it("retries a failed read once before giving up", async () => {
  const edge = loadFresh();
  jest
    .spyOn(global, "fetch")
    .mockRejectedValueOnce(new Error("timeout"))
    .mockImplementation(async () => okResponse("OFF"));
  await expect(edge.getMaintenanceState()).resolves.toEqual(OFF);
});

it("fails closed when the isolate never read the state", async () => {
  const edge = loadFresh();
  jest.spyOn(global, "fetch").mockRejectedValue(new Error("redis down"));
  await expect(edge.getMaintenanceState()).resolves.toMatchObject({
    phase: "OFF",
    unreadable: true,
  });
});

it("fails closed once the last confirmed state is older than 15 minutes", async () => {
  const edge = loadFresh();
  const fetchSpy = jest
    .spyOn(global, "fetch")
    .mockImplementation(async () => okResponse("OFF"));
  await edge.getMaintenanceState();

  nowMs += 16 * 60_000;
  fetchSpy.mockRejectedValue(new Error("redis down"));
  await expect(edge.getMaintenanceState()).resolves.toMatchObject({
    unreadable: true,
  });
});

it("never serves the stale fallback past the 15-minute window from cache", async () => {
  const edge = loadFresh();
  const fetchSpy = jest
    .spyOn(global, "fetch")
    .mockImplementation(async () => okResponse("OFF"));
  await edge.getMaintenanceState();

  // A failure 10 s before the window closes serves the fallback once...
  nowMs += 15 * 60_000 - 10_000;
  fetchSpy.mockRejectedValue(new Error("redis down"));
  await expect(edge.getMaintenanceState()).resolves.toEqual(OFF);

  // ...and 20 s later the cached fallback has expired, so the read fails closed.
  nowMs += 20_000;
  await expect(edge.getMaintenanceState()).resolves.toMatchObject({
    unreadable: true,
  });
});
