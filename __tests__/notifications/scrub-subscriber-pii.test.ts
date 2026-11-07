/**
 * @jest-environment node
 */

/**
 * The one-time scrub of mirrored Novu subscriber profile data: a dry run
 * only counts; an apply nulls exactly the fields each subscriber carries.
 */
import {
  piiFieldsOf,
  scrubSubscriberPii,
  type NovuSubscriberApi,
} from "../../scripts/novu/scrub-subscriber-pii";

function novuWith(pages: Parameters<typeof piiFieldsOf>[0][][]) {
  const patch = jest.fn(async () => ({}));
  const search = jest.fn(async ({ after }: { after?: string }) => {
    const index = after ? Number(after) : 0;
    return {
      result: {
        data: pages[index],
        next: index + 1 < pages.length ? String(index + 1) : null,
      },
    };
  });
  const novu: NovuSubscriberApi = { subscribers: { search, patch } };
  return { novu, patch, search };
}

const MIRRORED = {
  subscriberId: "u1",
  email: "a@example.test",
  firstName: "A",
  lastName: "B",
  phone: "+910000000000",
  data: { routingMode: "BELL_AND_EMAIL" },
};
const CLEAN = { subscriberId: "u2", data: {}, email: null };

describe("scrubSubscriberPii", () => {
  it("counts without writing on a dry run, across pages", async () => {
    const t = novuWith([[MIRRORED], [CLEAN]]);

    const result = await scrubSubscriberPii(t.novu, { apply: false });

    expect(t.patch).not.toHaveBeenCalled();
    expect(t.search).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ scanned: 2, withPii: 1, scrubbed: 0 });
    expect(result.fieldCounts).toMatchObject({
      email: 1,
      phone: 1,
      data: 1,
      avatar: 0,
    });
  });

  it("nulls only the fields a subscriber carries, and skips clean ones", async () => {
    const t = novuWith([[MIRRORED, CLEAN]]);

    const result = await scrubSubscriberPii(t.novu, { apply: true });

    expect(t.patch).toHaveBeenCalledTimes(1);
    expect(t.patch).toHaveBeenCalledWith(
      { email: null, firstName: null, lastName: null, phone: null, data: null },
      "u1",
    );
    expect(result.scrubbed).toBe(1);
  });

  it("records a failed write and keeps going", async () => {
    const t = novuWith([[MIRRORED, { ...MIRRORED, subscriberId: "u3" }]]);
    t.patch.mockRejectedValueOnce(new Error("Novu 500"));

    const result = await scrubSubscriberPii(t.novu, { apply: true });

    expect(result.failures).toEqual([
      { subscriberId: "u1", error: "Novu 500" },
    ]);
    expect(result.scrubbed).toBe(1);
  });
});
