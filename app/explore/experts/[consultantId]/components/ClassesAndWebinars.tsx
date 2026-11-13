"use client";

import { ClassPlan, WebinarPlan } from "@prisma/client";
import { GraduationCap, BookOpen, Video } from "lucide-react";
import React, { useId, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

import ProgramRow from "@/app/explore/programs/components/ProgramRow";
import {
  generateProgramImageUrl,
  type ClassInstance,
  type ClassPlanProgram,
  type WebinarPlanProgram,
} from "@/lib/explore/programs";

// price is number at runtime via the extended client (#780)
type ClassPlanRow = Omit<ClassPlan, "price"> & {
  price: number;
  /** The next scheduled batch, which the card names as the start date. */
  classes: ClassInstance[];
};
type WebinarPlanRow = Omit<WebinarPlan, "price"> & { price: number };

interface ClassesAndWebinarsProps {
  classPlans: ClassPlanRow[];
  webinarPlans: WebinarPlanRow[];
  enrolledClassPlanIds?: Set<string>;
  registeredWebinarPlanIds?: Set<string>;
}

export const ClassesAndWebinars: React.FC<ClassesAndWebinarsProps> = ({
  classPlans,
  webinarPlans,
  enrolledClassPlanIds = new Set(),
  registeredWebinarPlanIds = new Set(),
}) => {
  const [activeTab, setActiveTab] = useState<"classes" | "webinars">("classes");
  const idBase = useId();

  const hasClasses = classPlans.length > 0;
  const hasWebinars = webinarPlans.length > 0;
  const hasContent = hasClasses || hasWebinars;
  // Tabs exist only when there are two kinds to switch between.
  const hasTabs = hasClasses && hasWebinars;
  const tabId = (key: "classes" | "webinars") => `${idBase}-tab-${key}`;
  const panelId = (key: "classes" | "webinars") => `${idBase}-panel-${key}`;

  // Adapt the profile page's plan rows to the `Program` shape ProgramCard
  // consumes, so the card, its badges, price formatting and deep links stay
  // identical to /explore/programs instead of being re-implemented here.
  const classPrograms = useMemo<ClassPlanProgram[]>(
    () =>
      classPlans.map((plan) => ({
        ...plan,
        type: "class" as const,
        classes: plan.classes,
        imageUrl: generateProgramImageUrl(plan.imageUrl),
        isRegistered: enrolledClassPlanIds.has(plan.id),
      })),
    [classPlans, enrolledClassPlanIds],
  );

  const webinarPrograms = useMemo<WebinarPlanProgram[]>(
    () =>
      webinarPlans.map((plan) => ({
        ...plan,
        type: "webinar" as const,
        webinars: [],
        imageUrl: generateProgramImageUrl(plan.imageUrl),
        isRegistered: registeredWebinarPlanIds.has(plan.id),
      })),
    [webinarPlans, registeredWebinarPlanIds],
  );

  // Auto-select webinars if no classes
  React.useEffect(() => {
    if (!hasClasses && hasWebinars) {
      setActiveTab("webinars");
    }
  }, [hasClasses, hasWebinars]);

  if (!hasContent) {
    return null;
  }

  const tabs = [
    {
      key: "classes" as const,
      label: "Classes",
      icon: BookOpen,
      count: classPlans.length,
    },
    {
      key: "webinars" as const,
      label: "Webinars",
      icon: Video,
      count: webinarPlans.length,
    },
  ];

  // Arrow keys, Home and End move between tabs and select as they go, the
  // pattern for tabs whose panels are already rendered or cheap to switch to.
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const keys = tabs.map((t) => t.key);
    const current = keys.indexOf(activeTab);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (current + 1) % keys.length;
    else if (event.key === "ArrowLeft")
      next = (current - 1 + keys.length) % keys.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = keys.length - 1;
    if (next === null) return;
    event.preventDefault();
    setActiveTab(keys[next]);
    document.getElementById(tabId(keys[next]))?.focus();
  };

  // One ternary, not a nested pair: the subtitle for a profile with a single kind.
  const single = hasClasses
    ? { count: classPlans.length, one: "class", many: "classes" }
    : { count: webinarPlans.length, one: "webinar", many: "webinars" };
  const subtitle = `${single.count} ${single.count === 1 ? single.one : single.many}`;

  return (
    <div>
      <div className="bg-card rounded-2xl border border-border overflow-hidden">
        {/* Header with Tabs */}
        <div className="border-b border-border px-6 md:px-8 py-5">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center">
                <GraduationCap className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  Programs by this Expert
                </h2>
                {/* The tabs already carry both counts; the subtitle only earns
                    its place when there are no tabs to read them from. */}
                {!hasTabs && (
                  <p className="text-sm text-muted-foreground">{subtitle}</p>
                )}
              </div>
            </div>

            {hasTabs && (
              // Switches between two panels on this page, so it is a tablist.
              // Only the selected tab is in the tab order; arrows move within.
              // The key handler sits on the focusable tabs, not on the list.
              <div
                role="tablist"
                aria-label="Program type"
                className="flex bg-muted rounded-xl p-1"
              >
                {tabs.map(({ key, label, icon: Icon, count }) => (
                  <button
                    key={key}
                    id={tabId(key)}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === key}
                    aria-controls={panelId(key)}
                    tabIndex={activeTab === key ? 0 : -1}
                    onKeyDown={onTabKeyDown}
                    onClick={() => setActiveTab(key)}
                    className={`relative px-3 py-2 text-sm font-medium rounded-lg transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-4 ${
                      activeTab === key
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {activeTab === key && (
                      <motion.div
                        layoutId="activeTab"
                        className="absolute inset-0 bg-card rounded-lg shadow-sm"
                        transition={{
                          type: "spring",
                          bounce: 0.2,
                          duration: 0.4,
                        }}
                      />
                    )}
                    <span className="relative flex items-center gap-2">
                      <Icon className="w-4 h-4" />
                      {label} ({count})
                    </span>
                  </button>
                ))}
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
                {...(hasTabs && {
                  role: "tabpanel",
                  id: panelId("classes"),
                  "aria-labelledby": tabId("classes"),
                })}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.3 }}
              >
                {/* One horizontal row at any count: the section keeps a fixed
                    height however many programs there are. */}
                <ProgramRow programs={classPrograms} />
              </motion.div>
            )}

            {activeTab === "webinars" && hasWebinars && (
              <motion.div
                key="webinars"
                {...(hasTabs && {
                  role: "tabpanel",
                  id: panelId("webinars"),
                  "aria-labelledby": tabId("webinars"),
                })}
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.3 }}
              >
                <ProgramRow programs={webinarPrograms} />
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
                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-muted flex items-center justify-center">
                  {activeTab === "classes" ? (
                    <BookOpen className="w-8 h-8 text-muted-foreground/70" />
                  ) : (
                    <Video className="w-8 h-8 text-muted-foreground/70" />
                  )}
                </div>
                <p className="text-muted-foreground">
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
