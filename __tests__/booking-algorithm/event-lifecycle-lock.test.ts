/**
 * The event's checkout key as a host lifecycle write holds it (cancel, re-time,
 * make-up): renewable per Serializable attempt, and refused with copy meant
 * for the host rather than for a buyer.
 */
jest.mock("../../lib/redis", () => {
  const { MockRedis } = jest.requireActual("../../lib/redis-mock");
  const client = new MockRedis();
  return {
    __esModule: true,
    default: client,
    withCircuitBreaker: jest.fn(async (fn: () => unknown) => fn()),
    checkRedisHealth: jest.fn(async () => true),
    __test: { client },
  };
});

import {
  EVENT_LIFECYCLE_LOCK_TTL_MS,
  EventCheckoutBusyError,
  lockEventCheckout,
  unlockEventCheckout,
  withEventCheckoutLock,
} from "../../utils/appointmentlock";
import type { MockRedis } from "../../lib/redis-mock";

const { client } = (
  jest.requireMock("../../lib/redis") as { __test: { client: MockRedis } }
).__test;
const KEY = "event-checkout:WEBINAR:web-1";

beforeEach(() => client.clear());

it("re-arms the key to a full lifecycle TTL on every renew", async () => {
  await withEventCheckoutLock(
    { appointmentType: "WEBINAR", eventId: "web-1" },
    async (renew) => {
      await client.pexpire(KEY, 1_000);
      await renew();
      expect(await client.pttl(KEY)).toBeGreaterThan(
        EVENT_LIFECYCLE_LOCK_TTL_MS / 2,
      );
    },
  );
  expect(await client.get(KEY)).toBeNull();
});

it("stops the write when the key was lost between attempts", async () => {
  await expect(
    withEventCheckoutLock(
      { appointmentType: "WEBINAR", eventId: "web-1" },
      async (renew) => {
        await client.del(KEY);
        await client.set(KEY, "a-buyer", { px: 60_000 });
        await renew();
      },
    ),
  ).rejects.toBeInstanceOf(EventCheckoutBusyError);
  expect(await client.get(KEY)).toBe("a-buyer");
});

it("tells the host, not a buyer, that a seat is being booked", async () => {
  const buyer = await lockEventCheckout("WEBINAR", "web-1", 60_000);
  try {
    const refusal = await withEventCheckoutLock(
      { appointmentType: "WEBINAR", eventId: "web-1" },
      async () => "never",
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(EventCheckoutBusyError);
    expect((refusal as Error).message).toMatch(
      /someone is booking a seat on this webinar/i,
    );
  } finally {
    await unlockEventCheckout(buyer);
  }
}, 20_000);
