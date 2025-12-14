import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RegistrationBadge } from "@/components/ui/registration-badge";
import { ClassPlan, WebinarPlan } from "@prisma/client";
import {
  CalendarIcon,
  ClockIcon,
  Users2Icon,
  BookOpenIcon,
  GlobeIcon,
  DollarSignIcon,
  GraduationCapIcon,
  PackageIcon,
} from "lucide-react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import React from "react";

interface ClassesAndWebinarsProps {
  classPlans: ClassPlan[];
  webinarPlans: WebinarPlan[];
  /** Optional: Set of class plan IDs the user is enrolled in */
  enrolledClassPlanIds?: Set<string>;
  /** Optional: Set of webinar plan IDs the user is registered for */
  registeredWebinarPlanIds?: Set<string>;
}

export const ClassesAndWebinars: React.FC<ClassesAndWebinarsProps> = ({
  classPlans,
  webinarPlans,
  enrolledClassPlanIds = new Set(),
  registeredWebinarPlanIds = new Set(),
}) => {
  const router = useRouter();
  const { data: session } = useSession();
  const isLoggedIn = !!session?.user;
  const renderClassPlanCard = (classPlan: ClassPlan) => {
    const isEnrolled = isLoggedIn && enrolledClassPlanIds.has(classPlan.id);

    return (
      <Card
        key={classPlan.id}
        className="hover:shadow-lg transition-shadow duration-300 flex flex-col h-full"
      >
        <CardContent className="p-6 flex flex-col h-full">
          <div className="flex justify-between items-start mb-3">
            <h3 className="text-xl font-semibold">{classPlan.title}</h3>
            {isEnrolled && <RegistrationBadge type="class" compact />}
          </div>
          <div className="flex flex-wrap gap-2 mb-4">
          <Badge variant="secondary" className="flex items-center gap-1">
            <GlobeIcon className="w-3 h-3" />
            {classPlan.language}
          </Badge>
          <Badge variant="secondary" className="flex items-center gap-1">
            <GraduationCapIcon className="w-3 h-3" />
            {classPlan.level}
          </Badge>
          <Badge variant="secondary" className="flex items-center gap-1">
            <Users2Icon className="w-3 h-3" />
            {classPlan.maxParticipants} participants
          </Badge>
        </div>
        <div className="flex items-center gap-3 text-sm text-gray-600 mb-4">
          <div className="flex items-center">
            <CalendarIcon className="w-4 h-4 mr-1" />
            {classPlan.durationInMonths} month
            {classPlan.durationInMonths > 1 ? "s" : ""}
          </div>
          <div className="flex items-center">
            <ClockIcon className="w-4 h-4 mr-1" />
            {classPlan.totalHours} total hour
            {classPlan.totalHours > 1 ? "s" : ""}
          </div>
        </div>
        <div className="text-xs text-gray-500 mb-4">
          {classPlan.totalSessions} sessions · {classPlan.meetingsPerWeek}/week · {classPlan.sessionDurationInHours}h each
        </div>
        <p className="text-gray-700 mb-4 line-clamp-3">
          {classPlan.description}
        </p>
        <div className="space-y-3 mb-4 flex-grow">
          <div className="flex items-start gap-2">
            <BookOpenIcon className="w-4 h-4 mt-1 text-gray-500" />
            <div>
              <p className="text-sm font-medium">Prerequisites</p>
              <p className="text-sm text-gray-600">{classPlan.prerequisites}</p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <PackageIcon className="w-4 h-4 mt-1 text-gray-500" />
            <div>
              <p className="text-sm font-medium">Materials</p>
              <p className="text-sm text-gray-600">
                {classPlan.materialProvided}
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-1">
            <DollarSignIcon className="w-4 h-4 text-gray-700" />
            <span className="text-lg font-semibold">${classPlan.price}</span>
          </div>
          {classPlan.certificateProvided && (
            <Badge variant="outline" className="text-xs">
              Certificate Provided
            </Badge>
          )}
        </div>
        <Button
          variant="outline"
          className="w-full mt-auto cursor-pointer transition-colors duration-300 hover:bg-black hover:text-white"
          onClick={() =>
            router.push(`/explore/programs/plans/classes/${classPlan.id}`)
          }
        >
          {isEnrolled ? "View Details" : "Register Now"}
        </Button>
      </CardContent>
    </Card>
    );
  };

  const renderWebinarPlanCard = (webinarPlan: WebinarPlan) => {
    const isRegistered =
      isLoggedIn && registeredWebinarPlanIds.has(webinarPlan.id);

    return (
      <Card
        key={webinarPlan.id}
        className="hover:shadow-lg transition-shadow duration-300 flex flex-col h-full"
      >
        <CardContent className="p-6 flex flex-col h-full">
          <div className="flex justify-between items-start mb-3">
            <h3 className="text-xl font-semibold">{webinarPlan.title}</h3>
            {isRegistered && <RegistrationBadge type="webinar" compact />}
          </div>
          <div className="flex flex-wrap gap-2 mb-4">
          <Badge variant="secondary" className="flex items-center gap-1">
            <GlobeIcon className="w-3 h-3" />
            {webinarPlan.language}
          </Badge>
          <Badge variant="secondary" className="flex items-center gap-1">
            <GraduationCapIcon className="w-3 h-3" />
            {webinarPlan.level}
          </Badge>
          <Badge variant="secondary" className="flex items-center gap-1">
            <Users2Icon className="w-3 h-3" />
            {webinarPlan.maxParticipants} participants
          </Badge>
        </div>
        <div className="flex items-center gap-3 text-sm text-gray-600 mb-4">
          <div className="flex items-center">
            <CalendarIcon className="w-4 h-4 mr-1" />
            Schedule TBA
          </div>
          <div className="flex items-center">
            <ClockIcon className="w-4 h-4 mr-1" />
            {webinarPlan.durationInHours} hour
            {webinarPlan.durationInHours > 1 ? "s" : ""}
          </div>
        </div>
        <p className="text-gray-700 mb-4 line-clamp-3">
          {webinarPlan.description}
        </p>
        <div className="space-y-3 mb-4 flex-grow">
          <div className="flex items-start gap-2">
            <BookOpenIcon className="w-4 h-4 mt-1 text-gray-500" />
            <div>
              <p className="text-sm font-medium">Prerequisites</p>
              <p className="text-sm text-gray-600">
                {webinarPlan.prerequisites}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <PackageIcon className="w-4 h-4 mt-1 text-gray-500" />
            <div>
              <p className="text-sm font-medium">Materials</p>
              <p className="text-sm text-gray-600">
                {webinarPlan.materialProvided}
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center mb-4">
          <div className="flex items-center gap-1">
            <DollarSignIcon className="w-4 h-4 text-gray-700" />
            <span className="text-lg font-semibold">${webinarPlan.price}</span>
          </div>
        </div>
        <Button
          variant="outline"
          className="w-full mt-auto cursor-pointer transition-colors duration-300 hover:bg-black hover:text-white"
          onClick={() =>
            router.push(`/explore/programs/plans/webinars/${webinarPlan.id}`)
          }
        >
          {isRegistered ? "View Details" : "Register Now"}
        </Button>
      </CardContent>
    </Card>
    );
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-12 space-y-12">
      <section>
        <h2 className="text-3xl font-bold mb-6">Class Plans</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {classPlans.map((classPlan) => renderClassPlanCard(classPlan))}
        </div>
      </section>
      <section>
        <h2 className="text-3xl font-bold mb-6">Webinar Plans</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {webinarPlans.map((webinarPlan) =>
            renderWebinarPlanCard(webinarPlan),
          )}
        </div>
      </section>
    </div>
  );
};
