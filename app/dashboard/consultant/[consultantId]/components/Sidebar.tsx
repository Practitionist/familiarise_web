import React from "react";
import { DashboardSection, SidebarProps } from "../types";
import {
  LayoutDashboard,
  MessageCircle,
  Calendar,
  ClipboardList,
  FileText,
  HelpCircle,
  LogOut,
  Settings,
} from "lucide-react";

const getIcon = (section: DashboardSection) => {
  switch (section) {
    case DashboardSection.Home:
      return LayoutDashboard;
    case DashboardSection.Chats:
      return MessageCircle;
    case DashboardSection.Appointments:
      return Calendar;
    case DashboardSection.Requests:
      return ClipboardList;
    case DashboardSection.Documents:
      return FileText;
    case DashboardSection.Help:
      return HelpCircle;
    default:
      return LayoutDashboard;
  }
};

export function Sidebar({
  activeSection,
  setActiveSection,
  consultant,
}: Readonly<SidebarProps>) {
  const sections = [
    DashboardSection.Home,
    DashboardSection.Chats,
    DashboardSection.Appointments,
    DashboardSection.Requests,
    DashboardSection.Documents,
    DashboardSection.Help,
  ];
  return (
    <aside className="col-span-2 bg-gray-50 min-h-[calc(100vh-8rem)] rounded-xl flex flex-col">
      {/* Profile Section */}
      <div className="p-6 border-b border-gray-200">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            {consultant?.user?.image ? (
              <img
                src={consultant.user.image}
                alt={consultant.user.name ?? ""}
                className="w-10 h-10 rounded-full"
              />
            ) : (
              <div className="w-10 h-10 bg-blue-600 rounded-full flex items-center justify-center">
                <span className="text-white font-bold">
                  {consultant?.user?.name?.charAt(0)}
                </span>
              </div>
            )}
            <div>
              <h3 className="font-semibold text-gray-900">
                {consultant?.user?.name}
              </h3>
              {/* <p className="text-sm text-gray-500">
                {consultant?.specialization}
              </p> */}
              <span className="text-xs font-medium text-blue-600 bg-blue-50 px-2 py-1 rounded-full">
                {consultant?.specialization}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1">
        {sections.map((section) => {
          const Icon = getIcon(section);
          return (
            <button
              key={section}
              onClick={() => setActiveSection(section)}
              className={`w-full text-left px-4 py-3 rounded-lg transition-all duration-200 flex items-center gap-3 ${
                activeSection === section
                  ? "bg-blue-50 text-blue-600 font-medium"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              <Icon
                size={20}
                className={
                  activeSection === section ? "text-blue-600" : "text-gray-500"
                }
              />
              <span>{section}</span>
            </button>
          );
        })}
      </nav>

      {/* Bottom Section */}
      <div className="p-4 border-t border-gray-200">
        <button className="w-full text-left px-4 py-3 rounded-lg transition-all duration-200 flex items-center gap-3 text-gray-600 hover:bg-gray-100">
          <Settings size={20} className="text-gray-500" />
          <span>Settings</span>
        </button>
        <button className="w-full text-left px-4 py-3 rounded-lg transition-all duration-200 flex items-center gap-3 text-red-600 hover:bg-red-50">
          <LogOut size={20} />
          <span>Logout</span>
        </button>
      </div>
    </aside>
  );
}
