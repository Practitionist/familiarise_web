import prisma from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";
import { ClassDetails } from "./components/ClassDetails";

type ClassWithRelations = Prisma.ClassGetPayload<{
  include: {
    classPlan: {
      include: {
        consultantProfile: {
          include: {
            user: true;
          };
        };
        topics: true;
        classContents: {
          orderBy: {
            order: "asc";
          };
        };
      };
    };
    waitlist: true;
    appointments: {
      include: {
        slotsOfAppointment: true;
      };
    };
    meetingRoom: true;
  };
}>;

async function getClass(classId: string): Promise<ClassWithRelations | null> {
  return prisma.class.findUnique({
    where: { id: classId },
    include: {
      classPlan: {
        include: {
          consultantProfile: {
            include: {
              user: true,
            },
          },
          topics: true,
          classContents: {
            orderBy: {
              order: "asc",
            },
          },
        },
      },
      waitlist: true,
      appointments: {
        include: {
          slotsOfAppointment: true,
        },
      },
      meetingRoom: true,
    },
  });
}

interface PageProps {
  params: { classId: string };
}

export default async function ClassDetailsPage({ params }: PageProps) {
  const classData = await getClass(params.classId);

  if (!classData) {
    redirect("/explore/programs/classes");
  }

  return <ClassDetails classData={classData} />;
}
