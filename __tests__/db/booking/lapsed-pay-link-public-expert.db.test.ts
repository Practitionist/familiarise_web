/**
 * The Home "Request again" item for a lapsed pay link links to the expert's
 * public page, so the real reader offers it only while that page is public:
 * the expert VERIFIED and not deleted.
 */
import prisma from "../../../lib/prisma";
import { readLapsedPayLinks } from "../../../lib/data/lapsed-pay-links";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";

async function lapsedLink(expert: {
  verificationStatus: "VERIFIED" | "PENDING_VERIFICATION";
  deleted?: boolean;
}) {
  const host = await seedHost();
  await prisma.consultantProfile.update({
    where: { id: host.consultantProfileId },
    data: {
      verificationStatus: expert.verificationStatus,
      deletedAt: expert.deleted ? new Date() : null,
    },
  });
  const consultee = await seedConsultee();
  const startsAt = futureAt(4, 9);
  const request = await seedOneToOne(
    "consultation",
    host,
    consultee,
    { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    {
      status: "EXPIRED",
      bookingSource: "REQUEST_SUBMITTED",
      isTentative: true,
    },
  );
  await prisma.bookingStatusHistory.create({
    data: {
      entity: "CONSULTATION",
      entityId: request.consultationId!,
      appointmentId: request.appointmentId,
      fromStatus: "APPROVED_PENDING_PAYMENT",
      toStatus: "EXPIRED",
      reason: "PAYMENT_LAPSED",
    },
  });
  return { consultee, request };
}

describe("the lapsed pay-link reader", () => {
  it("offers Request again only while the expert's page is public", async () => {
    const shown = await lapsedLink({ verificationStatus: "VERIFIED" });
    const unverified = await lapsedLink({
      verificationStatus: "PENDING_VERIFICATION",
    });
    const deleted = await lapsedLink({
      verificationStatus: "VERIFIED",
      deleted: true,
    });

    const links = async (c: { consulteeProfileId: string }) =>
      (await readLapsedPayLinks(c.consulteeProfileId)).map((l) => l.id);
    expect(await links(shown.consultee)).toEqual([
      shown.request.consultationId,
    ]);
    expect(await links(unverified.consultee)).toEqual([]);
    expect(await links(deleted.consultee)).toEqual([]);
  });
});
