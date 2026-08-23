import { CollaboratorStatus } from "@prisma/client";

/**
 * Shared Prisma `include` shapes for the public plan list endpoints.
 *
 * Extracted from app/api/plans/{classes,webinars}/route.ts so the RSC seed
 * for /explore/programs (lib/data/explore-programs.ts getDefaultProgramsPage)
 * reads with the exact same shape the API serves. If a route needs an extra
 * field on list items, add it here — a hand-copied include in the data layer
 * would silently drift and break seed/fetch parity on the explore grid.
 * Lives in lib/ (not app/api/plans/shared/) because lib/data imports it and
 * lib/ must not depend on the app/ routing layer.
 */

// Card-facing consultant summary: name, avatar, up to 3 work experiences.
const consultantProfileListInclude = {
  include: {
    user: {
      select: {
        name: true,
        image: true,
        workExperiences: {
          select: {
            company: true,
            companyDomain: true,
            isCurrent: true,
          },
          orderBy: [
            { isCurrent: "desc" as const },
            { startDate: "desc" as const },
          ],
          take: 3,
        },
      },
    },
  },
};

const collaboratorsListInclude = {
  where: { status: CollaboratorStatus.ACCEPTED },
  include: {
    consultantProfile: consultantProfileListInclude,
  },
};

/** Include for GET /api/plans/classes list items. */
export function classPlanListInclude(opts: {
  includeClasses: boolean;
  includeRegistration: boolean;
}) {
  // Registration needs each class's appointments + slot users to compute
  // isRegistered client-side; the anonymous list only needs the classes rows.
  let classesInclude: boolean | Record<string, unknown> = true;
  if (opts.includeRegistration) {
    classesInclude = {
      include: {
        appointments: {
          include: {
            slotsOfAppointment: {
              include: {
                user: { select: { id: true } },
              },
            },
          },
        },
      },
    };
  }

  return {
    consultantProfile: consultantProfileListInclude,
    topics: true,
    classContents: true,
    collaborators: collaboratorsListInclude,
    ...((opts.includeClasses || opts.includeRegistration) && {
      classes: classesInclude,
    }),
  };
}

/** Include for GET /api/plans/webinars list items. */
export function webinarPlanListInclude(opts: { includeRegistration: boolean }) {
  const include: Record<string, unknown> = {
    consultantProfile: consultantProfileListInclude,
    topics: true,
    collaborators: collaboratorsListInclude,
  };

  if (opts.includeRegistration) {
    include.webinars = {
      include: {
        appointment: {
          include: {
            slotsOfAppointment: {
              include: {
                user: { select: { id: true } },
              },
            },
          },
        },
      },
    };
  }

  return include;
}
