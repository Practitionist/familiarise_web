import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { useRouter } from "next/navigation";
import React from "react";

interface ClassesAndWebinarsProps {
  classPlans: ClassPlan[];
  webinarPlans: WebinarPlan[];
}

export const ClassesAndWebinars: React.FC<ClassesAndWebinarsProps> = ({
  classPlans,
  webinarPlans,
}) => {
  const router = useRouter();
  const renderClassPlanCard = (classPlan: ClassPlan) => (
    <Card
      key={classPlan.id}
      className="group bg-gradient-to-br from-gray-900/90 to-gray-800/80 border border-gray-700/40 hover:border-gray-500/60 hover:shadow-2xl hover:shadow-gray-900/50 transition-all duration-500 flex flex-col h-full backdrop-blur-sm overflow-hidden relative"
    >
      {/* Elegant shimmer effect on hover */}
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000 pointer-events-none" />

      <CardContent className="p-8 flex flex-col h-full relative z-10">
        <h3 className="text-2xl font-bold mb-4 text-white tracking-tight">{classPlan.title}</h3>

        <div className="flex flex-wrap gap-2 mb-6">
          <Badge variant="secondary" className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800/60 border border-gray-700/50 text-gray-200 backdrop-blur-sm">
            <GlobeIcon className="w-3.5 h-3.5" />
            <span className="text-xs font-medium">{classPlan.language}</span>
          </Badge>
          <Badge variant="secondary" className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800/60 border border-gray-700/50 text-gray-200 backdrop-blur-sm">
            <GraduationCapIcon className="w-3.5 h-3.5" />
            <span className="text-xs font-medium">{classPlan.level}</span>
          </Badge>
          <Badge variant="secondary" className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800/60 border border-gray-700/50 text-gray-200 backdrop-blur-sm">
            <Users2Icon className="w-3.5 h-3.5" />
            <span className="text-xs font-medium">{classPlan.maxParticipants} participants</span>
          </Badge>
        </div>

        <div className="flex items-center gap-4 text-sm text-gray-300 mb-5">
          <div className="flex items-center gap-1.5">
            <CalendarIcon className="w-4 h-4" />
            <span>Schedule TBA</span>
          </div>
          <div className="flex items-center gap-1.5">
            <ClockIcon className="w-4 h-4" />
            <span>{classPlan.durationInMonths} month{classPlan.durationInMonths > 1 ? "s" : ""}</span>
          </div>
        </div>

        <p className="text-gray-300 mb-6 line-clamp-3 leading-relaxed">
          {classPlan.description}
        </p>

        <div className="space-y-4 mb-6 flex-grow">
          <div className="flex items-start gap-3 p-3 rounded-lg bg-gray-800/30 border border-gray-700/30">
            <BookOpenIcon className="w-5 h-5 mt-0.5 text-gray-400 flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-white mb-1">Prerequisites</p>
              <p className="text-sm text-gray-300 leading-relaxed">{classPlan.prerequisites}</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-gray-800/30 border border-gray-700/30">
            <PackageIcon className="w-5 h-5 mt-0.5 text-gray-400 flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-white mb-1">Materials</p>
              <p className="text-sm text-gray-300 leading-relaxed">{classPlan.materialProvided}</p>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between mb-6 pt-6 border-t border-gray-700/50">
          <div className="flex items-center gap-2">
            <DollarSignIcon className="w-6 h-6 text-white" />
            <span className="text-3xl font-bold text-white tracking-tight">${classPlan.price}</span>
          </div>
          {classPlan.certificateProvided && (
            <Badge variant="outline" className="text-xs px-3 py-1 bg-gray-800/50 border-gray-600/50 text-gray-200">
              🎓 Certificate
            </Badge>
          )}
        </div>

        <Button
          className="w-full mt-auto cursor-pointer transition-all duration-300 bg-white hover:bg-gray-100 text-black font-semibold py-6 text-base shadow-lg hover:shadow-xl hover:scale-[1.02]"
          onClick={() =>
            router.push(`/explore/programs/plans/classes/${classPlan.id}`)
          }
        >
          Register Now
        </Button>
      </CardContent>
    </Card>
  );

  const renderWebinarPlanCard = (webinarPlan: WebinarPlan) => (
    <Card
      key={webinarPlan.id}
      className="group bg-gradient-to-br from-gray-900/90 to-gray-800/80 border border-gray-700/40 hover:border-gray-500/60 hover:shadow-2xl hover:shadow-gray-900/50 transition-all duration-500 flex flex-col h-full backdrop-blur-sm overflow-hidden relative"
    >
      {/* Elegant shimmer effect on hover */}
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000 pointer-events-none" />

      <CardContent className="p-8 flex flex-col h-full relative z-10">
        <h3 className="text-2xl font-bold mb-4 text-white tracking-tight">{webinarPlan.title}</h3>

        <div className="flex flex-wrap gap-2 mb-6">
          <Badge variant="secondary" className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800/60 border border-gray-700/50 text-gray-200 backdrop-blur-sm">
            <GlobeIcon className="w-3.5 h-3.5" />
            <span className="text-xs font-medium">{webinarPlan.language}</span>
          </Badge>
          <Badge variant="secondary" className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800/60 border border-gray-700/50 text-gray-200 backdrop-blur-sm">
            <GraduationCapIcon className="w-3.5 h-3.5" />
            <span className="text-xs font-medium">{webinarPlan.level}</span>
          </Badge>
          <Badge variant="secondary" className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800/60 border border-gray-700/50 text-gray-200 backdrop-blur-sm">
            <Users2Icon className="w-3.5 h-3.5" />
            <span className="text-xs font-medium">{webinarPlan.maxParticipants} participants</span>
          </Badge>
        </div>

        <div className="flex items-center gap-4 text-sm text-gray-300 mb-5">
          <div className="flex items-center gap-1.5">
            <CalendarIcon className="w-4 h-4" />
            <span>Schedule TBA</span>
          </div>
          <div className="flex items-center gap-1.5">
            <ClockIcon className="w-4 h-4" />
            <span>{webinarPlan.durationInHours} hour{webinarPlan.durationInHours > 1 ? "s" : ""}</span>
          </div>
        </div>

        <p className="text-gray-300 mb-6 line-clamp-3 leading-relaxed">
          {webinarPlan.description}
        </p>

        <div className="space-y-4 mb-6 flex-grow">
          <div className="flex items-start gap-3 p-3 rounded-lg bg-gray-800/30 border border-gray-700/30">
            <BookOpenIcon className="w-5 h-5 mt-0.5 text-gray-400 flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-white mb-1">Prerequisites</p>
              <p className="text-sm text-gray-300 leading-relaxed">{webinarPlan.prerequisites}</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-gray-800/30 border border-gray-700/30">
            <PackageIcon className="w-5 h-5 mt-0.5 text-gray-400 flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-white mb-1">Materials</p>
              <p className="text-sm text-gray-300 leading-relaxed">{webinarPlan.materialProvided}</p>
            </div>
          </div>
        </div>

        <div className="flex items-center mb-6 pt-6 border-t border-gray-700/50">
          <div className="flex items-center gap-2">
            <DollarSignIcon className="w-6 h-6 text-white" />
            <span className="text-3xl font-bold text-white tracking-tight">${webinarPlan.price}</span>
          </div>
        </div>

        <Button
          className="w-full mt-auto cursor-pointer transition-all duration-300 bg-white hover:bg-gray-100 text-black font-semibold py-6 text-base shadow-lg hover:shadow-xl hover:scale-[1.02]"
          onClick={() =>
            router.push(`/explore/programs/plans/webinars/${webinarPlan.id}`)
          }
        >
          Register Now
        </Button>
      </CardContent>
    </Card>
  );

  return (
    <div className="w-full py-16 space-y-16">
      {classPlans.length > 0 && (
        <section>
          <div className="mb-8">
            <h2 className="text-4xl font-bold mb-2 text-white tracking-tight">Class Plans</h2>
            <div className="h-1 w-20 bg-gradient-to-r from-white to-gray-600 rounded-full"></div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {classPlans.map((classPlan) => renderClassPlanCard(classPlan))}
          </div>
        </section>
      )}
      {webinarPlans.length > 0 && (
        <section>
          <div className="mb-8">
            <h2 className="text-4xl font-bold mb-2 text-white tracking-tight">Webinar Plans</h2>
            <div className="h-1 w-20 bg-gradient-to-r from-white to-gray-600 rounded-full"></div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {webinarPlans.map((webinarPlan) =>
              renderWebinarPlanCard(webinarPlan),
            )}
          </div>
        </section>
      )}
    </div>
  );
};
