import type { Prisma } from "@prisma/client";
import type { ICollaboratorInfo } from "../../types";
import type { PlanFileIncluded } from "../../components/PlanDetailBody";
import type { ConsultantPublicScalars } from "@/lib/data/consultant-public";

// price is number at runtime via the extended client (#780)
// consultantProfile is projected to the public allowlist (no statutory PII). (#946)
export type TWebinarPlanData = Omit<
  Prisma.WebinarPlanGetPayload<{
    include: {
      consultantProfile: {
        select: ConsultantPublicScalars & {
          user: {
            select: { id: true; name: true; image: true };
          };
          domain: true;
          subDomains: true;
          tags: true;
        };
      };
      topics: true;
      faqs: true;
      webinars: {
        include: {
          appointment: {
            include: {
              occurrences: true;
              _count: { select: { participants: true } };
            };
          };
        };
      };
    };
  }>,
  "price"
> & {
  price: number;
  collaborators?: ICollaboratorInfo[];
  /** Names and types only, for the "Files included" card. */
  materials?: PlanFileIncluded[];
};

export type TSessionStatus =
  "Upcoming" | "Happening Now" | "Completed" | "To be announced";
