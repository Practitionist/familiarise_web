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
  type Appointment,
  type Document,
  type Activity,
  type Approval,
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
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <div className="bg-white p-8 rounded-lg shadow-md">
          <h2 className="text-2xl font-bold text-red-600 mb-4">Error</h2>
          <p className="text-gray-700">{error}</p>
        </div>
      </div>
    );
  }

  if (isLoading || !consultant) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-100">
        <div className="bg-white p-8 rounded-lg shadow-md">
          <h2 className="text-2xl font-bold mb-4">Loading...</h2>
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
    <div className="bg-gray-100 min-h-screen">
      <div className="w-full pt-32 pb-12 px-4">
        <Header
          name={consultant.user.name ?? ""}
          role={consultant.user.role ?? ""}
        />
        <main className="grid grid-cols-12 gap-6 mt-6">
          <Sidebar
            activeSection={activeSection}
            setActiveSection={setActiveSection}
            consultant={consultant}
          />
          <section className="col-span-10">{renderContent()}</section>
        </main>
      </div>
    </div>
  );
}
