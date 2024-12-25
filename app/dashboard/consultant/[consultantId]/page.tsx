"use client";

import React, { use, useEffect, useState } from "react";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { HomeTab } from "./tabs/HomeTab";
import { ChatsTab } from "./tabs/ChatsTab";
import { AppointmentsTab } from "./tabs/AppointmentsTab";
import { RequestsTab } from "./tabs/RequestsTab";
import { DocumentsTab } from "./tabs/DocumentsTab";
import { HelpTab } from "./tabs/HelpTab";
import { SettingsTab } from "./tabs/SettingsTab";
import {
  fetchConsultantData,
  fetchAppointments,
  fetchDocuments,
  fetchActivities,
  fetchApprovals,
} from "./utils";
import {
  type IAppointment,
  type IDocument,
  type IActivity,
  type IApproval,
  DashboardSection,
  BADGE_STYLES,
  TIME_CONSTANTS,
} from "./types";
import { TConsultantProfile } from "@/types/consultant";

type PageProps = {
  params: Promise<{ consultantId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function ConsultantDashboard({
  params,
  searchParams,
}: Readonly<PageProps>) {
  const resolvedParams = use(params);
  const consultantId = resolvedParams.consultantId;

  const [activeSection, setActiveSection] = useState<DashboardSection>(
    DashboardSection.Home,
  );
  const [consultant, setConsultant] = useState<TConsultantProfile | null>(null);
  const [appointments, setAppointments] = useState<IAppointment[]>([]);
  const [documents, setDocuments] = useState<IDocument[]>([]);
  const [activities, setActivities] = useState<IActivity[]>([]);
  const [approvals, setApprovals] = useState<IApproval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Prevent body scroll when sidebar is open on mobile
  useEffect(() => {
    if (isSidebarOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "unset";
    }
    return () => {
      document.body.style.overflow = "unset";
    };
  }, [isSidebarOpen]);

  useEffect(() => {
    async function fetchData() {
      try {
        setIsLoading(true);
        setError(null);

        const [
          consultantData,
          appointmentsData,
          documentsData,
          activitiesData,
          approvalsData,
        ] = await Promise.all([
          fetchConsultantData(consultantId),
          fetchAppointments(consultantId),
          fetchDocuments(consultantId),
          fetchActivities(consultantId),
          fetchApprovals(consultantId),
        ]);

        setConsultant(consultantData);
        setAppointments(appointmentsData);
        setDocuments(documentsData);
        setActivities(activitiesData);
        setApprovals(approvalsData);
      } catch (err) {
        console.error("Error fetching data:", err);
        setError(err instanceof Error ? err.message : "An error occurred");
      } finally {
        setIsLoading(false);
      }
    }

    fetchData();
  }, [consultantId]);

  // Handle sidebar toggle for mobile
  const toggleSidebar = () => {
    setIsSidebarOpen(!isSidebarOpen);
  };

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <div className="bg-white p-4 sm:p-8 rounded-lg shadow-md w-full max-w-md mx-4">
          <h2 className="text-xl sm:text-2xl font-bold text-red-600 mb-4">
            Error
          </h2>
          <p className="text-gray-700">{error}</p>
        </div>
      </div>
    );
  }

  if (isLoading || !consultant) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <div className="bg-white p-4 sm:p-8 rounded-lg shadow-md w-full max-w-md mx-4">
          <h2 className="text-xl sm:text-2xl font-bold mb-4">Loading...</h2>
          <p className="text-gray-700">Please wait while we fetch your data.</p>
        </div>
      </div>
    );
  }

  // Filter appointments for today
  const todayAppointments = appointments.filter((appointment) => {
    if (appointment.badge === "Completed") return false;
    if (
      appointment.badge.includes("min") ||
      appointment.badge.includes("hours")
    ) {
      return true;
    }
    return !appointment.time.includes(",");
  });

  // Get upcoming appointments (not today)
  const upcomingAppointments = appointments
    .filter((appointment) => {
      if (
        appointment.badge === "Completed" ||
        appointment.badge.includes("min") ||
        appointment.badge.includes("hours")
      ) {
        return false;
      }
      return (
        appointment.time.includes(",") ||
        appointment.badge === "Tomorrow" ||
        appointment.badge.startsWith("In ")
      );
    })
    .sort((a, b) => {
      const getTimeValue = (badge: string) => {
        if (badge === "Tomorrow") return 1;

        const numberRegex = /\d+/;
        let match;

        if (badge.includes("day")) {
          match = numberRegex.exec(badge);
          return parseInt(match?.[0] ?? "0") + 1;
        }
        if (badge.includes("week")) {
          match = numberRegex.exec(badge);
          return parseInt(match?.[0] ?? "0") * TIME_CONSTANTS.DAYS_IN_WEEK + 1;
        }
        if (badge.includes("month")) {
          match = numberRegex.exec(badge);
          return parseInt(match?.[0] ?? "0") * TIME_CONSTANTS.DAYS_IN_MONTH + 1;
        }
        if (badge.includes("year")) {
          match = numberRegex.exec(badge);
          return parseInt(match?.[0] ?? "0") * TIME_CONSTANTS.DAYS_IN_YEAR + 1;
        }
        return 999999;
      };
      return getTimeValue(a.badge) - getTimeValue(b.badge);
    });

  function getBadgeStyle(badge: string): string {
    // Check for exact matches first
    if (BADGE_STYLES[badge]) {
      return BADGE_STYLES[badge];
    }

    // Check for partial matches
    if (badge.includes("5 min")) {
      return BADGE_STYLES["Meeting in 5 min"];
    }
    if (badge.includes("2 hours")) {
      return BADGE_STYLES["Meeting in 2 hours"];
    }
    if (badge.includes("week")) {
      return BADGE_STYLES["In week"];
    }
    if (badge.includes("month")) {
      return BADGE_STYLES["In month"];
    }
    if (badge.includes("year")) {
      return BADGE_STYLES["In year"];
    }

    return BADGE_STYLES.default;
  }

  const renderContent = () => {
    switch (activeSection) {
      case DashboardSection.Home:
        return (
          <HomeTab
            todayAppointments={todayAppointments}
            upcomingAppointments={upcomingAppointments}
            activities={activities}
            approvals={approvals}
            getBadgeStyle={getBadgeStyle}
          />
        );
      case DashboardSection.Chats:
        return <ChatsTab />;
      case DashboardSection.Appointments:
        return (
          <AppointmentsTab
            appointments={appointments}
            getBadgeStyle={getBadgeStyle}
          />
        );
      case DashboardSection.Requests:
        return <RequestsTab approvals={approvals} />;
      case DashboardSection.Documents:
        return <DocumentsTab documents={documents} />;
      case DashboardSection.Help:
        return <HelpTab />;
      case DashboardSection.Settings:
        return consultant ? <SettingsTab consultant={consultant} /> : null;
      default:
        return null;
    }
  };

  return (
    <div className="bg-gray-100 min-h-screen relative">
      <div className="w-full pt-16 sm:pt-24 lg:pt-32 pb-6 sm:pb-8 lg:pb-12 px-2 sm:px-4 lg:px-6">
        <Header
          name={consultant.user.name ?? ""}
          role={consultant.user.role ?? ""}
          onMenuClick={toggleSidebar}
        />
        <main className="relative flex flex-col lg:flex-row gap-4 lg:gap-6 mt-4 lg:mt-6">
          {/* Mobile sidebar overlay */}
          <div
            className={`
              fixed inset-0 bg-black/50 z-40 lg:hidden
              transition-opacity duration-200
              ${isSidebarOpen ? "opacity-100" : "opacity-0 pointer-events-none"}
            `}
            onClick={toggleSidebar}
            aria-hidden="true"
          />

          {/* Sidebar container */}
          <div
            className={`
              fixed lg:relative inset-y-0 left-0 z-50
              w-[280px] lg:w-auto lg:flex-shrink-0 lg:flex-grow-0 lg:basis-2/12
              transform ${isSidebarOpen ? "translate-x-0" : "-translate-x-full"}
              lg:translate-x-0 transition-transform duration-200 ease-out
              overflow-hidden
            `}
          >
            <Sidebar
              activeSection={activeSection}
              setActiveSection={(section) => {
                setActiveSection(section);
                setIsSidebarOpen(false);
              }}
              consultant={consultant}
            />
          </div>

          {/* Main content */}
          <div className="lg:flex-grow lg:basis-10/12">{renderContent()}</div>
        </main>
      </div>
    </div>
  );
}
