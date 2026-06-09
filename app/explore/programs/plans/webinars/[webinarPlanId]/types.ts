import type { Prisma } from "@prisma/client";
import type { ICollaboratorInfo } from "../../types";

// price is number at runtime via the extended client (#780)
export type TWebinarPlanData = Omit<
  Prisma.WebinarPlanGetPayload<{
    include: {
      consultantProfile: {
        include: {
          user: {
            select: { id: true; name: true; email: true; image: true };
          };
          domain: true;
          subDomains: true;
          tags: true;
        };
      };
      topics: true;
      webinars: {
        include: {
          appointment: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: {
                    select: { id: true };
                  };
                };
              };
              payment: true;
            };
          };
          waitlist: {
            select: { userId: true; position: true; status: true };
          };
        };
      };
    };
  }>,
  "price"
> & {
  price: number;
  collaborators?: ICollaboratorInfo[];
};

export type TSessionStatus =
  | "Upcoming"
  | "Happening Now"
  | "Completed"
  | "To be announced";
