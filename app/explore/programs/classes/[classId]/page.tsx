import prisma from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { redirect } from "next/navigation";
import { ClassDetails } from "./components/ClassDetails";

type ClassWithRelations = Prisma.ClassPlanGetPayload<{
  include: {
    consultantProfile: {
      include: {
        user: true;
      };
    };
    topics: true;
    classes: {
      where: {
        status: "SCHEDULED";
      };
      take: 1;
      include: {
        waitlist: true;
      };
    };
    classContents: {
      orderBy: {
        order: "asc";
      };
    };
  };
}>;

async function getClassPlan(
  classId: string,
): Promise<ClassWithRelations | null> {
  return prisma.classPlan.findUnique({
    where: { id: classId },
    include: {
      consultantProfile: {
        include: {
          user: true,
        },
      },
      topics: true,
      classes: {
        where: {
          status: "SCHEDULED",
        },
        take: 1,
        include: {
          waitlist: true,
        },
      },
      classContents: {
        orderBy: {
          order: "asc",
        },
      },
    },
  });
}

interface PageProps {
  params: { classId: string };
}

export default async function ClassDetailsPage({
  params,
}: PageProps) {
  const classPlan = await getClassPlan(params.classId);

  if (!classPlan) {
    redirect("/explore/programs/classes");
  }

  const activeClass = classPlan.classes[0];
  const startDate = activeClass?.startDate || undefined;

  return <ClassDetails classPlan={classPlan} startDate={startDate} />;
}
