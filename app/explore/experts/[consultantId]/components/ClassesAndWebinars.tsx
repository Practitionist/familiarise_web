"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RegistrationBadge } from "@/components/ui/registration-badge";
import { ClassPlan, WebinarPlan } from "@prisma/client";
import {
  Clock,
  Users,
  Globe,
  GraduationCap,
  ArrowRight,
  BookOpen,
  Video,
  Sparkles,
  Play,
} from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useCurrency } from "@/lib/hooks/useCurrency";

interface ClassesAndWebinarsProps {
  classPlans: ClassPlan[];
  webinarPlans: WebinarPlan[];
  enrolledClassPlanIds?: Set<string>;
  registeredWebinarPlanIds?: Set<string>;
}

// Generate a deterministic gradient based on ID
const getGradient = (id: string, type: "class" | "webinar") => {
  const hash = id.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const gradients =
    type === "class"
      ? [
          "from-zinc-900 via-zinc-800 to-zinc-700",
          "from-slate-900 via-slate-800 to-slate-700",
          "from-neutral-900 via-neutral-800 to-neutral-700",
          "from-stone-900 via-stone-800 to-stone-700",
        ]
      : [
          "from-zinc-800 via-zinc-700 to-zinc-600",
          "from-slate-800 via-slate-700 to-slate-600",
          "from-neutral-800 via-neutral-700 to-neutral-600",
          "from-stone-800 via-stone-700 to-stone-600",
        ];
  return gradients[hash % gradients.length];
};

export const ClassesAndWebinars: React.FC<ClassesAndWebinarsProps> = ({
  classPlans,
  webinarPlans,
  enrolledClassPlanIds = new Set(),
  registeredWebinarPlanIds = new Set(),
}) => {
  const router = useRouter();
  const { data: session } = useSession();
  const { formatPrice } = useCurrency();
  const isLoggedIn = !!session?.user;
  const [activeTab, setActiveTab] = useState<"classes" | "webinars">("classes");

  const hasClasses = classPlans.length > 0;
  const hasWebinars = webinarPlans.length > 0;
  const hasContent = hasClasses || hasWebinars;

  // Auto-select webinars if no classes
  React.useEffect(() => {
    if (!hasClasses && hasWebinars) {
      setActiveTab("webinars");
    }
  }, [hasClasses, hasWebinars]);

  if (!hasContent) {
    return null;
  }

  const renderClassCard = (classPlan: ClassPlan, index: number) => {
    const isEnrolled = isLoggedIn && enrolledClassPlanIds.has(classPlan.id);
    const gradient = getGradient(classPlan.id, "class");

    return (
      <motion.div
        key={classPlan.id}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: index * 0.1 }}
        className="group"
      >
        <div
          className="relative bg-white rounded-2xl border border-zinc-200 overflow-hidden hover:border-zinc-300 hover:shadow-xl transition-all duration-300 cursor-pointer h-full flex flex-col"
          onClick={() =>
            router.push(`/explore/programs/plans/classes/${classPlan.id}`)
          }
        >
          {/* Cover Image/Gradient */}
          <div
            className={`relative h-44 md:h-48 bg-gradient-to-br ${gradient} overflow-hidden`}
          >
            <div className="absolute inset-0 grid-pattern opacity-20" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-16 h-16 rounded-2xl bg-white/10 backdrop-blur-sm flex items-center justify-center">
                <BookOpen className="w-8 h-8 text-white" />
              </div>
            </div>
            {/* Badges */}
            <div className="absolute top-4 left-4 flex gap-2">
              <Badge className="bg-white text-zinc-900 font-medium">
                Class
              </Badge>
              {isEnrolled && <RegistrationBadge type="class" compact />}
            </div>
            {/* Price Tag */}
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
              <span className="px-3 py-1.5 sm:px-4 sm:py-2 bg-white rounded-full text-sm sm:text-base lg:text-lg font-bold text-zinc-900 shadow-lg whitespace-nowrap">
                {formatPrice(classPlan.price)}
              </span>
            </div>
          </div>

          {/* Content */}
          <div className="p-4 sm:p-5 md:p-6 flex flex-col flex-1 min-w-0">
            <h3 className="text-base sm:text-lg font-semibold text-zinc-900 mb-2 line-clamp-2 group-hover:text-zinc-700 transition-colors min-h-[2.5rem] sm:min-h-[3rem]">
              {classPlan.title}
            </h3>

            <p className="text-xs sm:text-sm text-zinc-500 mb-3 sm:mb-4 line-clamp-3 min-h-[3rem] sm:min-h-[3.75rem]">
              {classPlan.description}
            </p>

            {/* Stats Row */}
            <div className="flex flex-wrap gap-x-3 gap-y-1 mb-3 sm:mb-4">
              <div className="flex items-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs text-zinc-500">
                <Clock className="w-3 h-3 sm:w-3.5 sm:h-3.5 flex-shrink-0" />
                <span className="whitespace-nowrap">
                  {classPlan.durationInMonths} month
                  {classPlan.durationInMonths > 1 ? "s" : ""}
                </span>
              </div>
              <div className="flex items-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs text-zinc-500">
                <Users className="w-3 h-3 sm:w-3.5 sm:h-3.5 flex-shrink-0" />
                <span className="whitespace-nowrap">
                  {classPlan.maxParticipants} max
                </span>
              </div>
              <div className="flex items-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs text-zinc-500">
                <GraduationCap className="w-3 h-3 sm:w-3.5 sm:h-3.5 flex-shrink-0" />
                <span>{classPlan.level}</span>
              </div>
            </div>

            {/* Tags */}
            <div className="flex flex-wrap gap-1.5 sm:gap-2 mb-4">
              <Badge
                variant="secondary"
                className="text-[10px] sm:text-xs bg-zinc-100 text-zinc-600 h-fit"
              >
                <Globe className="w-2.5 h-2.5 sm:w-3 sm:h-3 mr-0.5 sm:mr-1" />
                {classPlan.language}
              </Badge>
              {classPlan.certificateProvided && (
                <Badge
                  variant="secondary"
                  className="text-[10px] sm:text-xs bg-emerald-50 text-emerald-700 h-fit"
                >
                  <Sparkles className="w-2.5 h-2.5 sm:w-3 sm:h-3 mr-0.5 sm:mr-1" />
                  Certificate
                </Badge>
              )}
            </div>

            {/* CTA */}
            <Button
              className="w-full bg-zinc-900 hover:bg-zinc-800 text-white rounded-xl h-10 sm:h-11 text-sm font-medium group/btn mt-auto"
              onClick={(e) => {
                e.stopPropagation();
                router.push(`/explore/programs/plans/classes/${classPlan.id}`);
              }}
            >
              <span>{isEnrolled ? "View Class" : "Learn More"}</span>
              <ArrowRight className="w-4 h-4 ml-2 group-hover/btn:translate-x-1 transition-transform" />
            </Button>
          </div>
        </div>
      </motion.div>
    );
  };

  const renderWebinarCard = (webinarPlan: WebinarPlan, index: number) => {
    const isRegistered =
      isLoggedIn && registeredWebinarPlanIds.has(webinarPlan.id);
    const gradient = getGradient(webinarPlan.id, "webinar");

    return (
      <motion.div
        key={webinarPlan.id}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: index * 0.1 }}
        className="group"
      >
        <div
          className="relative bg-white rounded-2xl border border-zinc-200 overflow-hidden hover:border-zinc-300 hover:shadow-xl transition-all duration-300 cursor-pointer h-full flex flex-col"
          onClick={() =>
            router.push(`/explore/programs/plans/webinars/${webinarPlan.id}`)
          }
        >
          {/* Cover Image/Gradient */}
          <div
            className={`relative h-44 md:h-48 bg-gradient-to-br ${gradient} overflow-hidden`}
          >
            <div className="absolute inset-0 grid-pattern opacity-20" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-16 h-16 rounded-2xl bg-white/10 backdrop-blur-sm flex items-center justify-center">
                <Play className="w-8 h-8 text-white ml-1" />
              </div>
            </div>
            {/* Badges */}
            <div className="absolute top-4 left-4 flex gap-2">
              <Badge className="bg-white/90 text-zinc-900 font-medium">
                Webinar
              </Badge>
              {isRegistered && <RegistrationBadge type="webinar" compact />}
            </div>
            {/* Price Tag */}
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2">
              <span className="px-3 py-1.5 sm:px-4 sm:py-2 bg-white rounded-full text-sm sm:text-base lg:text-lg font-bold text-zinc-900 shadow-lg whitespace-nowrap">
                {formatPrice(webinarPlan.price)}
              </span>
            </div>
          </div>

          {/* Content */}
          <div className="p-4 sm:p-5 md:p-6 flex flex-col flex-1 min-w-0">
            <h3 className="text-base sm:text-lg font-semibold text-zinc-900 mb-2 line-clamp-2 group-hover:text-zinc-700 transition-colors min-h-[2.5rem] sm:min-h-[3rem]">
              {webinarPlan.title}
            </h3>

            <p className="text-xs sm:text-sm text-zinc-500 mb-3 sm:mb-4 line-clamp-3 min-h-[3rem] sm:min-h-[3.75rem]">
              {webinarPlan.description}
            </p>

            {/* Stats Row */}
            <div className="flex flex-wrap gap-x-3 gap-y-1 mb-3 sm:mb-4">
              <div className="flex items-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs text-zinc-500">
                <Clock className="w-3 h-3 sm:w-3.5 sm:h-3.5 flex-shrink-0" />
                <span className="whitespace-nowrap">
                  {webinarPlan.durationInHours} hour
                  {webinarPlan.durationInHours > 1 ? "s" : ""}
                </span>
              </div>
              <div className="flex items-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs text-zinc-500">
                <Users className="w-3 h-3 sm:w-3.5 sm:h-3.5 flex-shrink-0" />
                <span className="whitespace-nowrap">
                  {webinarPlan.maxParticipants} max
                </span>
              </div>
              <div className="flex items-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs text-zinc-500">
                <GraduationCap className="w-3 h-3 sm:w-3.5 sm:h-3.5 flex-shrink-0" />
                <span>{webinarPlan.level}</span>
              </div>
            </div>

            {/* Tags */}
            <div className="flex flex-wrap gap-1.5 sm:gap-2 mb-4">
              <Badge
                variant="secondary"
                className="text-[10px] sm:text-xs bg-zinc-100 text-zinc-600 h-fit"
              >
                <Globe className="w-2.5 h-2.5 sm:w-3 sm:h-3 mr-0.5 sm:mr-1" />
                {webinarPlan.language}
              </Badge>
              <Badge
                variant="secondary"
                className="text-[10px] sm:text-xs bg-zinc-100 text-zinc-600 h-fit"
              >
                <Video className="w-2.5 h-2.5 sm:w-3 sm:h-3 mr-0.5 sm:mr-1" />
                Live
              </Badge>
            </div>

            {/* CTA */}
            <Button
              className="w-full bg-zinc-900 hover:bg-zinc-800 text-white rounded-xl h-10 sm:h-11 text-sm font-medium group/btn mt-auto"
              onClick={(e) => {
                e.stopPropagation();
                router.push(
                  `/explore/programs/plans/webinars/${webinarPlan.id}`,
                );
              }}
            >
              <span>{isRegistered ? "View Webinar" : "Learn More"}</span>
              <ArrowRight className="w-4 h-4 ml-2 group-hover/btn:translate-x-1 transition-transform" />
            </Button>
          </div>
        </div>
      </motion.div>
    );
  };

  return (
    <div>
      <div className="bg-white rounded-2xl border border-zinc-200 overflow-hidden">
        {/* Header with Tabs */}
        <div className="border-b border-zinc-200 px-6 md:px-8 py-5">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-zinc-100 flex items-center justify-center">
                <GraduationCap className="w-5 h-5 text-zinc-600" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-zinc-900">
                  Programs by this Expert
                </h2>
                <p className="text-sm text-zinc-500">
                  {classPlans.length} class{classPlans.length !== 1 ? "es" : ""}{" "}
                  • {webinarPlans.length} webinar
                  {webinarPlans.length !== 1 ? "s" : ""}
                </p>
              </div>
            </div>

            {/* Tabs */}
            {hasClasses && hasWebinars && (
              <div className="flex bg-zinc-100 rounded-xl p-1">
                <button
                  onClick={() => setActiveTab("classes")}
                  className={`relative px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                    activeTab === "classes"
                      ? "text-zinc-900"
                      : "text-zinc-500 hover:text-zinc-700"
                  }`}
                >
                  {activeTab === "classes" && (
                    <motion.div
                      layoutId="activeTab"
                      className="absolute inset-0 bg-white rounded-lg shadow-sm"
                      transition={{
                        type: "spring",
                        bounce: 0.2,
                        duration: 0.4,
                      }}
                    />
                  )}
                  <span className="relative flex items-center gap-2">
                    <BookOpen className="w-4 h-4" />
                    Classes ({classPlans.length})
                  </span>
                </button>
                <button
                  onClick={() => setActiveTab("webinars")}
                  className={`relative px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                    activeTab === "webinars"
                      ? "text-zinc-900"
                      : "text-zinc-500 hover:text-zinc-700"
                  }`}
                >
                  {activeTab === "webinars" && (
                    <motion.div
                      layoutId="activeTab"
                      className="absolute inset-0 bg-white rounded-lg shadow-sm"
                      transition={{
                        type: "spring",
                        bounce: 0.2,
                        duration: 0.4,
                      }}
                    />
                  )}
                  <span className="relative flex items-center gap-2">
                    <Video className="w-4 h-4" />
                    Webinars ({webinarPlans.length})
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="p-6 md:p-8">
          <AnimatePresence mode="wait">
            {activeTab === "classes" && hasClasses && (
              <motion.div
                key="classes"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.3 }}
                className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 sm:gap-6 lg:gap-8"
              >
                {classPlans.map((classPlan, index) =>
                  renderClassCard(classPlan, index),
                )}
              </motion.div>
            )}

            {activeTab === "webinars" && hasWebinars && (
              <motion.div
                key="webinars"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.3 }}
                className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 sm:gap-6 lg:gap-8"
              >
                {webinarPlans.map((webinarPlan, index) =>
                  renderWebinarCard(webinarPlan, index),
                )}
              </motion.div>
            )}

            {/* Empty State */}
            {((activeTab === "classes" && !hasClasses) ||
              (activeTab === "webinars" && !hasWebinars)) && (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-center py-12"
              >
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-zinc-100 flex items-center justify-center">
                  {activeTab === "classes" ? (
                    <BookOpen className="w-8 h-8 text-zinc-400" />
                  ) : (
                    <Video className="w-8 h-8 text-zinc-400" />
                  )}
                </div>
                <p className="text-zinc-500">
                  No {activeTab === "classes" ? "classes" : "webinars"}{" "}
                  available yet
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
};
