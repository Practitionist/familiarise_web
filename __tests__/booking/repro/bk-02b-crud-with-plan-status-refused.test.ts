/**
 * @jest-environment node
 */

// Invariant: a plan-editor PATCH only saves a draft or publishes; any other status answers 409 USE_CANCEL_ROUTE before a write.

const transaction = jest.fn();
const webinarPlanFindUnique = jest.fn();
const classPlanFindUnique = jest.fn();

jest.mock("../../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (...a: unknown[]) => transaction(...a),
    webinarPlan: {
      findUnique: (...a: unknown[]) => webinarPlanFindUnique(...a),
    },
    classPlan: { findUnique: (...a: unknown[]) => classPlanFindUnique(...a) },
  },
}));
jest.mock("../../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn().mockResolvedValue({ user: { id: "user-1" } }),
}));
jest.mock("../../../utils/contentValidation", () =>
  jest.requireActual("../../fixtures/content-validation-stub"),
);

import {
  PATCH as webinarPatch,
  POST as webinarPost,
} from "../../../app/api/bookings/webinars/crud-with-plan/route";
import {
  PATCH as classPatch,
  POST as classPost,
} from "../../../app/api/bookings/classes/crud-with-plan/route";

const request = (body: unknown) =>
  ({ json: async () => body }) as unknown as Parameters<typeof webinarPatch>[0];

beforeEach(() => jest.clearAllMocks());

describe("crud-with-plan PATCH refuses a cancel-shaped status", () => {
  it.each(["CANCELLED", "COMPLETED"])(
    "webinar and class: status %s -> 409 USE_CANCEL_ROUTE, nothing read or written",
    async (status) => {
      for (const patch of [webinarPatch, classPatch]) {
        const res = await patch(request({ id: "plan-1", status }));
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ code: "USE_CANCEL_ROUTE" });
      }
      expect(webinarPlanFindUnique).not.toHaveBeenCalled();
      expect(classPlanFindUnique).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it("still admits the editor's publish intent past the status gate", async () => {
    webinarPlanFindUnique.mockResolvedValue(null);
    const res = await webinarPatch(
      request({ id: "plan-1", status: "SCHEDULED" }),
    );
    expect(res.status).toBe(404);
    expect(webinarPlanFindUnique).toHaveBeenCalled();
  });
});

it.each(["CANCELLED", "COMPLETED"])(
  "a webinar or class is created only as a draft or published, never %s",
  async (status) => {
    for (const post of [webinarPost, classPost]) {
      const res = await post(request({ status }) as never);
      expect(res.status).toBe(400);
      const { details } = await res.json();
      expect(details).toContainEqual(
        expect.objectContaining({ path: ["status"] }),
      );
    }
    expect(transaction).not.toHaveBeenCalled();
  },
);
