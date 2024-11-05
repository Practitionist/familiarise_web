import prisma from "./prisma";

///////////////////////////////////////////////////// CONSULTATION LOCK /////////////////////////////////////////////////////

async function createConsultationLock(appointmentId: string): Promise<boolean> {
  try {
    await prisma.appointmentLock.create({
      data: {
        appointment: {
          connect: { id: appointmentId },
        },
        expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes expiration
      },
    });
    return true;
  } catch (error: unknown) {
    if ((error as any).code === "P2002") {
      // Unique constraint violation
      return false; // Lock already exists
    }
    throw error;
  }
}

async function releaseConsultationLock(appointmentId: string): Promise<void> {
  await prisma.appointmentLock.delete({
    where: { appointmentId },
  });
}

///////////////////////////////////////////////////// SUBSCRIPTION LOCK /////////////////////////////////////////////////////

async function createSubscriptionLock(appointmentId: string): Promise<boolean> {
  try {
    await prisma.appointmentLock.create({
      data: {
        appointment: {
          connect: { id: appointmentId },
        },
        expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes expiration
      },
    });
    return true;
  } catch (error: unknown) {
    if ((error as any).code === "P2002") {
      // Unique constraint violation
      return false; // Lock already exists
    }
    throw error;
  }
}

async function releaseSubscriptionLock(appointmentId: string): Promise<void> {
  await prisma.appointmentLock.delete({
    where: { appointmentId },
  });
}

export {
  createConsultationLock,
  releaseConsultationLock,
  createSubscriptionLock,
  releaseSubscriptionLock,
};
