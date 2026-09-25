/**
 * @jest-environment node
 */

/**
 * #1771 K-7 — contesting a Razorpay dispute: a draft and then a submit reach
 * PATCH /v1/disputes/{id}/contest with the documented body, and a submit with
 * no document is refused before any call.
 */

import {
  contestDispute,
  RazorpayDisputeError,
} from "../../lib/payments/core/razorpay-disputes";

const fetchMock = jest.fn(
  async (_url: string, init: RequestInit) =>
    new Response(
      JSON.stringify({
        id: "disp_1",
        status:
          JSON.parse(String(init.body)).action === "submit"
            ? "under_review"
            : "open",
      }),
      { status: 200 },
    ),
);

beforeEach(() => {
  process.env.RAZORPAY_KEY_ID = "rzp_test_x";
  process.env.RAZORPAY_SECRET = "secret";
  fetchMock.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
});

it("saves a draft, then submits it", async () => {
  const evidence = { proof_of_service: ["doc_A1"] };
  const draft = await contestDispute("disp_1", {
    action: "draft",
    summary: "Session delivered on 3 Sep",
    evidence,
  });
  const submit = await contestDispute("disp_1", {
    action: "submit",
    amountPaise: 50_000,
    summary: "Session delivered on 3 Sep",
    evidence,
  });
  expect([draft.status, submit.status]).toEqual(["open", "under_review"]);
  const [url, init] = fetchMock.mock.calls[1];
  expect(url).toBe("https://api.razorpay.com/v1/disputes/disp_1/contest");
  expect(init.method).toBe("PATCH");
  expect(JSON.parse(String(init.body))).toEqual({
    action: "submit",
    summary: "Session delivered on 3 Sep",
    amount: 50_000,
    proof_of_service: ["doc_A1"],
  });
});

it("refuses a submit with no document before calling Razorpay", async () => {
  await expect(
    contestDispute("disp_1", { action: "submit", summary: "x", evidence: {} }),
  ).rejects.toEqual(expect.any(RazorpayDisputeError));
  await expect(
    contestDispute("disp_1", { action: "submit", summary: "x", evidence: {} }),
  ).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED" });
  expect(fetchMock).not.toHaveBeenCalled();
});
