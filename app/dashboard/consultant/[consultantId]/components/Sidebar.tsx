import React from "react";
import { DashboardSection, SidebarProps } from "../types";

export function Sidebar({ activeSection, setActiveSection }: SidebarProps) {
  const sections = [
    DashboardSection.Home,
    DashboardSection.Chats,
    DashboardSection.Appointments,
    DashboardSection.Requests,
    DashboardSection.Documents,
    DashboardSection.Help,
  ];

  return (
    <aside className="col-span-2">
      <nav className="space-y-2">
        {sections.map((section) => (
          <button
            key={section}
            onClick={() => setActiveSection(section)}
            className={`w-full text-left px-4 py-2 rounded-lg transition-colors ${
              activeSection === section
                ? "bg-blue-500 text-white"
                : "hover:bg-gray-200"
            }`}
          >
            {section}
          </button>
        ))}
      </nav>
    </aside>
  );
}
