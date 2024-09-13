import prisma from "./prisma";

///////////////////////////////////////////////////// CONSULTATION LOCK /////////////////////////////////////////////////////

async function createConsultationLock(consultationId: string): Promise<boolean> {
    try {
        await prisma.appointmentLock.create({
            data: {
                consultationId,
                expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes expiration
            },
        });
        return true;
    } catch (error: unknown) {
        if ((error as any).code === 'P2002') { // Unique constraint violation
            return false; // Lock already exists
        }
        throw error;
    }
}

async function releaseConsultationLock(consultationId: string): Promise<void> {
    await prisma.appointmentLock.delete({
        where: { consultationId },
    });
}

///////////////////////////////////////////////////// SUBSCRIPTION LOCK /////////////////////////////////////////////////////

async function createSubscriptionLock(subscriptionId: string): Promise<boolean> {
    try {
        await prisma.appointmentLock.create({
            data: {
                subscriptionId,
                expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes expiration
            },
        });
        return true;
    } catch (error: unknown) {
        if ((error as any).code === 'P2002') { // Unique constraint violation
            return false; // Lock already exists
        }
        throw error;
    }
}

async function releaseSubscriptionLock(subscriptionId: string): Promise<void> {
    await prisma.appointmentLock.delete({
        where: { subscriptionId },
    });
}