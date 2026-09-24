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
    <div className="flex w-full items-center gap-1 rounded-2xl border border-border bg-muted p-1.5 sm:w-fit sm:gap-2">
      {tabs.map((tab) => {
        const isActive = activeTab === tab.value;
        return (
          <button
            key={tab.value}
            onClick={() => onTabChange(tab.value)}
            className={`inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl px-2 py-2.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-auto sm:gap-2 sm:px-5 sm:text-sm ${
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
