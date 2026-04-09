"use client";

import { memo } from "react";
import { GraduationCap, Layers, Video } from "lucide-react";
import { ProgramType } from "../utils";

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
    <div className="flex items-center gap-2 p-1.5 bg-zinc-100 rounded-xl w-fit">
      {tabs.map((tab) => {
        const isActive = activeTab === tab.value;
        return (
          <button
            key={tab.value}
            onClick={() => onTabChange(tab.value)}
            className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
              isActive
                ? "bg-zinc-900 text-white shadow-sm"
                : "text-zinc-600 hover:text-zinc-900 hover:bg-zinc-200/60"
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
