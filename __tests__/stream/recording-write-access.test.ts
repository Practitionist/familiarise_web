/**
 * @jest-environment node
 */

jest.mock("server-only", () => ({}));
jest.mock("../../lib/stream/recording-retention", () => ({
  recordingRetentionLabels: jest.fn(async () => new Map()),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findFirst: jest.fn() },
    consultantProfile: { findUnique: jest.fn() },
    consulteeProfile: { findUnique: jest.fn(async () => null) },
    membership: { findFirst: jest.fn(async () => null) },
  },
}));

import prisma from "@/lib/prisma";
import { resolveRecordingWriteAccess } from "@/lib/stream/recording-write-access";

const none = {
  consultation: null,
  subscription: null,
  trial: null,
  webinar: null,
  class: null,
};
const oneToOne = {
  id: "a1",
  appointmentType: "CONSULTATION",
  ...none,
  consultation: {
    requestedById: "learner-p",
    consultationPlan: { title: "1:1", consultantProfileId: "host-p" },
  },
};
const orgClass = {
  id: "a2",
  appointmentType: "CLASS",
  ...none,
  class: {
    id: "c",
    schedulingPeriodStartsAt: null,
    classPlan: {
      id: "plan",
      title: "Class",
      lateJoinersGetPastRecordings: true,
      consultantProfileId: "host-p",
      organizationId: "org-1",
      collaborators: [{ consultantProfileId: "cohost-p" }],
      classContents: [],
    },
  },
};

async function access(
  booking: object,
  profileId: string | null,
  manager = false,
) {
  (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(booking);
  (prisma.consultantProfile.findUnique as jest.Mock).mockResolvedValue(
    profileId ? { id: profileId } : null,
  );
  (prisma.membership.findFirst as jest.Mock).mockResolvedValue(
    manager ? { role: "MANAGER", organization: { name: "LearnPro" } } : null,
  );
  return resolveRecordingWriteAccess(
    { id: "u", role: "USER" },
    { appointmentId: "a", sessionHostProfileId: "host-p" },
  );
}

describe("recording rename and delete follow the session-content rule", () => {
  it("allows the host and an accepted co-host", async () => {
    expect(await access(oneToOne, "host-p")).toEqual({
      allowed: true,
      via: "host",
    });
    expect(await access(orgClass, "cohost-p")).toEqual({
      allowed: true,
      via: "host",
    });
  });

  it("lets an org manager act only on its own group plans, never a 1:1", async () => {
    expect(await access(oneToOne, null, true)).toEqual({ allowed: false });
    expect(await access(orgClass, null, true)).toEqual({
      allowed: true,
      via: "org",
      orgName: "LearnPro",
    });
  });

  it("refuses a learner and a stranger", async () => {
    expect(await access(oneToOne, null)).toEqual({ allowed: false });
    expect(await access(orgClass, "someone-else")).toEqual({
      allowed: false,
    });
  });
});
