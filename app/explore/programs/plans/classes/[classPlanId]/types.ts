import type {
  Prisma,
  Class as PrismaClass,
  Appointment as PrismaAppointment,
  AppointmentOccurrence as PrismaAppointmentOccurrence,
} from "@prisma/client";
import type { ICollaboratorInfo } from "../../types";
import type { ConsultantPublicScalars } from "@/lib/data/consultant-public";

type TClassSessionWithSchedule = PrismaClass & {
  // #1554 — one wrapper per class, N occurrences.
  appointment:
    | (PrismaAppointment & {
        occurrences: PrismaAppointmentOccurrence[];
        // Seat ids only; the capacity gate counts these.
        participants: { userId: string }[];
      })
    | null;
};

export type TClassPlanDetailsData = Omit<
  Prisma.ClassPlanGetPayload<{
    include: {
      consultantProfile: {
        select: ConsultantPublicScalars & {
          user: { select: { id: true; name: true; email: true; image: true } };
          domain: true;
          subDomains: true;
          tags: true;
        };
      };
      topics: true;
      classContents: true;
      faqs: true;
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
