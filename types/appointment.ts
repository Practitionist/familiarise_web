import { Prisma } from "@prisma/client";

export type TAppointment = Prisma.AppointmentGetPayload<{
    include: {
        consultation: true,
        subscription: true,
        webinar: true,
        class: true,
        appointmentLock: true,
        payment: true,
        consultee: true,
        slotOfAppointment: {
            include: {
                slotOfAvailabilityCustom: {
                    include: {
                        consultantProfile: {
                            include: {
                                user: {
                                    select: {
                                        id: true,
                                        name: true,
                                        email: true,
                                        profilePicture: true,
                                    }
                                }
                            }
                        }
                    }
                }
                slotOfAvailabilityWeekly: {
                    include: {
                        consultantProfile: {
                            include: {
                                user: {
                                    select: {
                                        id: true,
                                        name: true,
                                        email: true,
                                        profilePicture: true,
                                    }
                                }
                            }
                        }
                    }
                }
                consulteeProfile: true,
            },
        }
    }
}>;
