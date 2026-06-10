import type {
  Prisma,
  Class as PrismaClass,
  Appointment as PrismaAppointment,
  SlotOfAppointment as PrismaSlotOfAppointment,
} from "@prisma/client";
import type { ICollaboratorInfo } from "../../types";

export type TClassSessionWithSchedule = PrismaClass & {
  appointments: (PrismaAppointment & {
    slotsOfAppointment: (PrismaSlotOfAppointment & {
      user: { id: string }[];
    })[];
  })[];
  waitlist?: Array<{ userId: string; position: number | null; status: string }>;
};

export type TClassPlanDetailsData = Omit<
  Prisma.ClassPlanGetPayload<{
    include: {
      consultantProfile: {
        include: {
          user: { select: { id: true; name: true; email: true; image: true } };
          domain: true;
          subDomains: true;
          tags: true;
        };
      };
      topics: true;
      classContents: true;
    };
  }>,
  "classes" | "price"
> & {
  // price is number at runtime via the extended client (#780)
  price: number;
  classes: TClassSessionWithSchedule[];
  type: "class";
  imageUrl: string;
  collaborators?: ICollaboratorInfo[];
};
