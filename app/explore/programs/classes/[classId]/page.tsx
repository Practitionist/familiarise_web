import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import prisma from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import Image from "next/image";
import { generateProgramImageUrl } from "../../utils";
import { ClassNotFound } from "./ClassNotFound";
import {
  BookIcon,
  CallsIcon,
  VideoIcon,
  EmailIcon,
  LanguageIcon,
  MaterialIcon,
  ParticipantsIcon,
  CertificateIcon,
} from "./icons";

type ClassPlanWithRelations = Prisma.ClassPlanGetPayload<{
  include: {
    consultantProfile: {
      include: {
        user: true;
      };
    };
    topics: true;
    classContents: true;
  };
}>;

async function getClassPlan(
  classId: string,
): Promise<ClassPlanWithRelations | null> {
  return prisma.classPlan.findUnique({
    where: { id: classId },
    include: {
      consultantProfile: {
        include: {
          user: true,
        },
      },
      classContents: true,
      topics: true,
    },
  });
}

type FeatureItemProps = {
  icon: React.ReactNode;
  label: string;
  value: string | number;
};

const FeatureItem = ({ icon, label, value }: FeatureItemProps) => (
  <div className="flex items-center gap-2">
    {icon}
    <span>
      {label}: {value}
    </span>
  </div>
);

type CourseContentProps = {
  contents: Array<{
    id: string;
    title: string;
    description: string;
    hoursAllotted: number;
  }>;
};

const CourseContent = ({ contents }: CourseContentProps) => (
  <Accordion type="single" collapsible className="w-full">
    {contents.map((content, index) => (
      <AccordionItem key={content.id} value={`item-${index + 1}`}>
        <AccordionTrigger>{content.title}</AccordionTrigger>
        <AccordionContent>
          <p>{content.description}</p>
          <p>Hours allotted: {content.hoursAllotted}</p>
        </AccordionContent>
      </AccordionItem>
    ))}
  </Accordion>
);

type CourseFeatureCardProps = {
  classPlan: ClassPlanWithRelations;
};

const CourseFeatureCard = ({ classPlan }: CourseFeatureCardProps) => (
  <Card className="mb-8">
    <CardContent className="grid grid-cols-2 gap-4 p-6">
      <FeatureItem
        icon={<BookIcon />}
        label="Duration"
        value={`${classPlan.durationInMonths} months`}
      />
      <FeatureItem
        icon={<CallsIcon />}
        label="Calls per week"
        value={classPlan.callsPerWeek}
      />
      <FeatureItem
        icon={<VideoIcon />}
        label="Video meetings"
        value={classPlan.videoMeetings}
      />
      <FeatureItem
        icon={<EmailIcon />}
        label="Email support"
        value={classPlan.emailSupport}
      />
      <FeatureItem
        icon={<LanguageIcon />}
        label="Language"
        value={classPlan.language || "Not specified"}
      />
      <FeatureItem
        icon={<MaterialIcon />}
        label="Material provided"
        value={classPlan.materialProvided || "Not specified"}
      />
      <FeatureItem
        icon={<ParticipantsIcon />}
        label="Max participants"
        value={classPlan.maxParticipants}
      />
      <FeatureItem
        icon={<CertificateIcon />}
        label="Certificate"
        value={classPlan.certificateProvided ? "Provided" : "Not provided"}
      />
    </CardContent>
  </Card>
);

type CourseInfoCardProps = {
  classPlan: ClassPlanWithRelations;
};

const CourseInfoCard = ({ classPlan }: CourseInfoCardProps) => (
  <Card>
    <CardHeader>
      <CardTitle>Course Information</CardTitle>
    </CardHeader>
    <CardContent>
      <p className="mb-4">
        A course by{" "}
        {classPlan.consultantProfile?.user?.name || "Unknown Instructor"}
      </p>
      {classPlan.topics.map((topic) => (
        <Badge key={topic.id} className="mr-2 mb-2">
          {topic.name}
        </Badge>
      ))}
    </CardContent>
    <CardFooter className="flex flex-col gap-4">
      <form action="/api/checkout/class" method="POST" className="w-full">
        <input type="hidden" name="classId" value={classPlan.id} />
        <Button type="submit" className="w-full">
          Enroll in course
        </Button>
      </form>
    </CardFooter>
  </Card>
);

export default async function ClassDetailsPage({
  params,
}: {
  params: Promise<{ classId: string }>;
}) {
  const resolvedParams = await params;
  const classPlan = await getClassPlan(resolvedParams.classId);

  if (!classPlan) {
    return <ClassNotFound />;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="relative h-[300px] w-full">
        <Image
          src={generateProgramImageUrl(classPlan.id, 1200, 300)}
          alt={classPlan.title}
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-black/50" />
      </div>

      <div className="container mx-auto px-4 -mt-20 relative">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="md:col-span-2">
            <Card className="mb-8">
              <CardContent className="p-6">
                <h1 className="text-3xl font-bold mb-2">{classPlan.title}</h1>
                <p className="text-xl font-semibold mb-4 text-blue-600">
                  ${classPlan.price} USD
                </p>
              </CardContent>
            </Card>

            <CourseFeatureCard classPlan={classPlan} />

            <h2 className="text-2xl font-semibold mb-4">Course Description</h2>
            <p className="mb-8 whitespace-pre-line">{classPlan.description}</p>

            <h2 className="text-2xl font-semibold mb-4">Course Content</h2>
            <CourseContent contents={classPlan.classContents} />
          </div>

          <div>
            <CourseInfoCard classPlan={classPlan} />
          </div>
        </div>
      </div>
    </div>
  );
}
