import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ClassPlan, WebinarPlan } from "@prisma/client";
import { CalendarIcon, ClockIcon } from "lucide-react";
import React from "react";

interface ClassesAndWebinarsProps {
  classPlans: ClassPlan[];
  webinarPlans: WebinarPlan[];
}

export const ClassesAndWebinars: React.FC<ClassesAndWebinarsProps> = ({
  classPlans,
  webinarPlans,
}) => {
  const renderClassPlanCard = (classPlan: ClassPlan) => (
    <Card
      key={classPlan.id}
      className="hover:shadow-lg transition-shadow duration-300 flex flex-col h-full"
    >
      <CardContent className="p-6 flex flex-col h-full">
        <h3 className="text-xl font-semibold mb-3">{classPlan.title}</h3>
        <div className="flex items-center gap-3 text-sm text-gray-600 mb-4">
          <div className="flex items-center">
            <CalendarIcon className="w-4 h-4 mr-1" />
            Schedule TBA
          </div>
          <div className="flex items-center">
            <ClockIcon className="w-4 h-4 mr-1" />
            Duration: {classPlan.durationInMonths} month
            {classPlan.durationInMonths > 1 ? "s" : ""}
          </div>
        </div>
        <p className="text-gray-700 mb-4 line-clamp-3 flex-grow">
          {classPlan.description}
        </p>
        <Button
          variant="outline"
          className="w-full mt-auto cursor-pointer transition-colors duration-300 hover:bg-black hover:text-white"
        >
          Register Now
        </Button>
      </CardContent>
    </Card>
  );

  const renderWebinarPlanCard = (webinarPlan: WebinarPlan) => (
    <Card
      key={webinarPlan.id}
      className="hover:shadow-lg transition-shadow duration-300 flex flex-col h-full"
    >
      <CardContent className="p-6 flex flex-col h-full">
        <h3 className="text-xl font-semibold mb-3">{webinarPlan.title}</h3>
        <div className="flex items-center gap-3 text-sm text-gray-600 mb-4">
          <div className="flex items-center">
            <CalendarIcon className="w-4 h-4 mr-1" />
            Schedule TBA
          </div>
          <div className="flex items-center">
            <ClockIcon className="w-4 h-4 mr-1" />
            Duration: {webinarPlan.durationInHours} hour
            {webinarPlan.durationInHours > 1 ? "s" : ""}
          </div>
        </div>
        <p className="text-gray-700 mb-4 line-clamp-3 flex-grow">
          {webinarPlan.description}
        </p>
        <Button
          variant="outline"
          className="w-full mt-auto cursor-pointer transition-colors duration-300 hover:bg-black hover:text-white"
        >
          Register Now
        </Button>
      </CardContent>
    </Card>
  );

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
