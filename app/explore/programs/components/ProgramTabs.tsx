"use client";

import { memo } from "react";
import { GraduationCap, Layers, Video } from "lucide-react";
import { ProgramType } from "@/lib/explore/programs";

interface ProgramTabsProps {
  activeTab: ProgramType;
  onTabChange: (tab: ProgramType) => void;
}

const tabs: { value: ProgramType; label: string; icon: React.ReactNode }[] = [
  {
    value: "all",
    label: "All",
    icon: <Layers className="w-4 h-4" />,
  },
  {
    value: "class",
    label: "Classes",
    icon: <GraduationCap className="w-4 h-4" />,
  },
  {
    value: "webinar",
    label: "Webinars",
    icon: <Video className="w-4 h-4" />,
  },
];

function ProgramTabsImpl({ activeTab, onTabChange }: ProgramTabsProps) {
  return (
    <div
      role="group"
      aria-label="Program type"
      className="flex max-w-full flex-wrap items-center gap-1 p-1.5 bg-muted rounded-2xl w-fit border border-border"
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.value;
        return (
          <button
            key={tab.value}
            type="button"
            aria-pressed={isActive}
            onClick={() => onTabChange(tab.value)}
            className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
              isActive
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10"
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

const ProgramTabs = memo(ProgramTabsImpl);
export default ProgramTabs;
