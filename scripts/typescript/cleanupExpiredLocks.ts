import prisma from "@/lib/prisma";

async function cleanupExpiredLocks() {
  const now = new Date();

  await prisma.appointmentLock.deleteMany({
    where: {
      expiresAt: { lt: now },
    },
  });

  console.log("Expired locks cleaned up");
}
