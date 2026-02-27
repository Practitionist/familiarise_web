import type { Prisma } from "@prisma/client";
import type { ICollaboratorInfo } from "../../types";

export type TWebinarPlanData = Prisma.WebinarPlanGetPayload<{
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
}> & {
  collaborators?: ICollaboratorInfo[];
};

export type TSessionStatus =
  | "Upcoming"
  | "Happening Now"
  | "Completed"
  | "To be announced";
