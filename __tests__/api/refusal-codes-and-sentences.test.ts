/**
 * @jest-environment node
 */

/**
 * 4xx answers carry a `code`, and the sentence a person reads is plain: no
 * route path, no bare "Required".
 */
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("@/lib/auth-helpers", () => ({
  ...jest.requireActual("@/lib/auth-helpers"),
  requireApiAuth: async () => ({
    session: { user: { id: "u-1", role: "CONSULTEE" } },
  }),
  requireOrgAccess: async () => ({
    session: { user: { id: "u-1" } },
    member: { id: "mem-1" },
  }),
  requireBackofficeSurface: async () => ({
    session: {
      session: { createdAt: new Date() },
      user: { id: "u-ops", role: "ADMIN" },
    },
  }),
}));
jest.mock("@/lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  eventMutationLimiter: {},
}));

import { NextRequest } from "next/server";
import { AppointmentStatus } from "@prisma/client";
import {
  validateDetailRequestStatusPatch,
  validateListRequestStatusPatch,
} from "@/lib/booking/request-route-guards";
import { GET as navCounts } from "@/app/api/backoffice/nav-counts/route";
import { POST as orgAllocate } from "@/app/api/organizations/[orgId]/appointments/[appointmentId]/allocate/route";
import { POST as staffCancel } from "@/app/api/staff/appointments/[appointmentId]/cancel/route";
import { PATCH as patchTrial } from "@/app/api/trials/[trialId]/route";

const ID = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const post = (url: string, body: unknown, method = "POST") =>
  new NextRequest(url, { method, body: JSON.stringify(body) });

it.each([
  ["list", () => validateListRequestStatusPatch(AppointmentStatus.CANCELLED, true, false)],
  ["detail", () => validateDetailRequestStatusPatch(AppointmentStatus.CANCELLED, true, false, false)],
])("the %s status PATCH names no route path when refusing a cancel", async (_n, run) => {
  const body = await run()!.json();
  expect(body.code).toBe("USE_CANCEL_ENDPOINT");
  expect(body.error).not.toMatch(/\/api\//);
});

it("refuses a back-office tree the role lacks with a code", async () => {
  const res = await navCounts(new NextRequest("http://x/api/backoffice/nav-counts?tree=nope"));
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({
    error: "Your role can't open this part of the back office.",
    code: "FORBIDDEN",
  });
});

it("asks an org allocate for its reason in a sentence", async () => {
  const res = await orgAllocate(
    post(`http://x/api/organizations/org-1/appointments/${ID}/allocate`, { isAuto: true }),
    { params: Promise.resolve({ orgId: "org-1", appointmentId: ID }) },
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/^Give a reason of at least 5 characters/);
});

it("asks a staff cancel with no refund preview for it in a sentence", async () => {
  const res = await staffCancel(
    post(`http://x/api/staff/appointments/${ID}/cancel`, {}),
    { params: Promise.resolve({ appointmentId: ID }) },
  );
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe(
    "Open the cancel preview to see the refund, then confirm the cancel.",
  );
});

it("tags a trial PATCH that fails validation VALIDATION_FAILED", async () => {
  const res = await patchTrial(
    post(`http://x/api/trials/${ID}`, { status: "NOT_A_STATUS" }, "PATCH"),
    { params: Promise.resolve({ trialId: ID }) },
  );
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({
    error: "Validation failed",
    code: "VALIDATION_FAILED",
  });
});
