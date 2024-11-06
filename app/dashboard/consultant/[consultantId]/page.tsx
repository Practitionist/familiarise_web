"use client";

import React, { Suspense, use, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { AppointmentCard } from "./components/AppointmentCard";
import { DocumentReviewTable } from "./components/DocumentReviewTable";
import { ClientActivity } from "./components/ClientActivity";
import { ApprovalsTable } from "./components/ApprovalsTable";
import ChatUI from "./components/ChatUI";
import {
  fetchConsultantData,
  fetchAppointments,
  fetchDocuments,
  fetchActivities,
  fetchApprovals,
  type Consultant,
  type Appointment,
  type Document,
  type Activity,
  type Approval,
} from "./utils";

type PageProps = {
  params: Promise<{ consultantId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default function ConsultantDashboard({ params, searchParams }: PageProps) {
  const resolvedParams = use(params);
  const consultantId = resolvedParams.consultantId;
  
  const [activeSection, setActiveSection] = useState("Home");
  const [consultant, setConsultant] = useState<Consultant | null>(null);
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

        // Log current time for debugging
        console.log('Fetching data at:', new Date().toLocaleString());

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

        // Log fetched data for debugging
        console.log('Fetched data:', {
          consultant: consultantData,
          appointments: appointmentsData.map(a => ({
            id: a.id,
            name: a.name,
            description: a.description,
            time: a.time,
            badge: a.badge
          })),
          documents: documentsData.length,
          activities: activitiesData.length,
          approvals: approvalsData.length
        });

        setConsultant(consultantData);
        setAppointments(appointmentsData);
        setDocuments(documentsData);
        setActivities(activitiesData);
        setApprovals(approvalsData);
      } catch (err) {
        console.error('Error fetching data:', err);
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

  // Filter appointments
  const todayAppointments = appointments.filter(appointment => {
    // If it's completed, don't show in today's appointments
    if (appointment.badge === 'Completed') {
      return false;
    }
    // If it's "Meeting in 5 min" or "Meeting in 2 hours", it's today
    if (appointment.badge.includes('min') || appointment.badge.includes('hours')) {
      return true;
    }
    // If it has no date (just time), it's today
    return !appointment.time.includes(',');
  });

  // Get upcoming appointments (not today)
  const upcomingAppointments = appointments.filter(appointment => {
    // If it's completed or today's appointment, don't show in upcoming
    if (appointment.badge === 'Completed' || 
        appointment.badge.includes('min') || 
        appointment.badge.includes('hours')) {
      return false;
    }
    // If it has a date or is marked as "Tomorrow" or "In X days/weeks/months/years", it's upcoming
    return appointment.time.includes(',') || 
           appointment.badge === 'Tomorrow' || 
           appointment.badge.startsWith('In ');
  });

  // Sort upcoming appointments by time
  const sortedUpcomingAppointments = upcomingAppointments.sort((a, b) => {
    // Helper function to get numeric value for sorting
    const getTimeValue = (badge: string) => {
      if (badge === 'Tomorrow') return 1;
      if (badge.includes('day')) {
        return parseInt(badge.match(/\d+/)?.[0] || '0') + 1;
      }
      if (badge.includes('week')) {
        return (parseInt(badge.match(/\d+/)?.[0] || '0') * 7) + 1;
      }
      if (badge.includes('month')) {
        return (parseInt(badge.match(/\d+/)?.[0] || '0') * 30) + 1;
      }
      if (badge.includes('year')) {
        return (parseInt(badge.match(/\d+/)?.[0] || '0') * 365) + 1;
      }
      return 999999; // For unknown formats
    };

    return getTimeValue(a.badge) - getTimeValue(b.badge);
  });

  const renderContent = () => {
    switch (activeSection) {
      case "Home":
        return (
          <div className="grid grid-cols-3 gap-6">
            <div className="col-span-2 space-y-6">
              <Suspense fallback={<div>Loading appointments...</div>}>
                <div className="bg-white p-6 rounded-lg shadow">
                  <h2 className="text-xl font-semibold mb-4">
                    Today's Appointments
                  </h2>
                  <div className="grid grid-cols-2 gap-4">
                    {todayAppointments.map((appointment) => (
                      <AppointmentCard key={appointment.id} {...appointment} />
                    ))}
                    {todayAppointments.length === 0 && (
                      <p className="text-gray-500 col-span-2">No appointments for today</p>
                    )}
                  </div>
                </div>
              </Suspense>
              <Suspense fallback={<div>Loading upcoming appointments...</div>}>
                <div className="bg-white p-6 rounded-lg shadow">
                  <h2 className="text-xl font-semibold mb-4">
                    Upcoming Appointments
                  </h2>
                  <ul className="space-y-4">
                    {sortedUpcomingAppointments.slice(0, 2).map((appointment) => (
                      <li key={appointment.id} className="flex items-center space-x-4">
                        <Avatar>
                          <AvatarImage alt={appointment.name} src="/placeholder.svg" />
                          <AvatarFallback>
                            {appointment.name
                              .split(" ")
                              .map((n: string) => n[0])
                              .join("")}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-grow">
                          <h3 className="text-lg font-semibold">{appointment.name}</h3>
                          <p className="text-sm text-gray-500">
                            {appointment.description}
                          </p>
                          <p className="text-sm">{appointment.time}</p>
                          <Badge
                            variant="secondary"
                            className={getBadgeStyle(appointment.badge)}
                          >
                            {appointment.badge}
                          </Badge>
                        </div>
                        <Button className="bg-blue-500 text-white">
                          Chat
                        </Button>
                      </li>
                    ))}
                    {sortedUpcomingAppointments.length === 0 && (
                      <p className="text-gray-500">No upcoming appointments</p>
                    )}
                  </ul>
                </div>
              </Suspense>
            </div>
            <div className="space-y-6">
              <Suspense fallback={<div>Loading client activity...</div>}>
                <div className="bg-white p-6 rounded-lg shadow">
                  <h2 className="text-xl font-semibold mb-4">
                    Clients Activity
                  </h2>
                  <ClientActivity activities={activities} />
                  <Button className="mt-4 w-full bg-blue-500 text-white">
                    Login Report
                  </Button>
                </div>
              </Suspense>
              <Suspense fallback={<div>Loading approvals...</div>}>
                <div className="bg-white p-6 rounded-lg shadow">
                  <h2 className="text-xl font-semibold mb-4">
                    Approvals for Consultations and Subscriptions
                  </h2>
                  <ApprovalsTable approvals={approvals.slice(0, 3)} />
                </div>
              </Suspense>
            </div>
          </div>
        );
      case "Chats":
        return (
          <div className="bg-white rounded-lg shadow h-[calc(100vh-200px)]">
            <ChatUI />
          </div>
        );
      case "Appointments":
        return (
          <div className="bg-white p-6 rounded-lg shadow">
            <h2 className="text-xl font-semibold mb-4">All Appointments</h2>
            <div className="grid grid-cols-2 gap-4 mb-6">
              {appointments.slice(0, 2).map((appointment) => (
                <AppointmentCard key={appointment.id} {...appointment} />
              ))}
            </div>
            <ul className="space-y-4">
              {appointments.slice(2).map((appointment) => (
                <li
                  key={appointment.id}
                  className="flex items-center justify-between p-4 bg-gray-100 rounded-lg"
                >
                  <div className="flex items-center space-x-4">
                    <Avatar>
                      <AvatarImage
                        alt={appointment.name}
                        src="/placeholder.svg"
                      />
                      <AvatarFallback>
                        {appointment.name
                          .split(" ")
                          .map((n: string) => n[0])
                          .join("")}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <h3 className="font-semibold">{appointment.name}</h3>
                      <p className="text-sm text-gray-600">
                        {appointment.description}
                      </p>
                      <p className="text-sm text-gray-500">
                        {appointment.time}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Badge
                      variant="secondary"
                      className={getBadgeStyle(appointment.badge)}
                    >
                      {appointment.badge}
                    </Badge>
                    <Button
                      variant="default"
                      className={appointment.badge.includes('5 min') 
                        ? "bg-black text-white hover:bg-gray-800"
                        : "bg-gray-400 text-white cursor-not-allowed"}
                      disabled={!appointment.badge.includes('5 min')}
                    >
                      Join meet
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      case "Requests":
        return (
          <div className="bg-white p-6 rounded-lg shadow">
            <h2 className="text-xl font-semibold mb-4">
              All Appointment Requests
            </h2>
            <ApprovalsTable approvals={approvals} />
          </div>
        );
      case "Documents for Review":
        return (
          <div className="bg-white p-6 rounded-lg shadow">
            <h2 className="text-xl font-semibold mb-4">Documents For Review</h2>
            <DocumentReviewTable documents={documents} />
          </div>
        );
      case "Help":
        return (
          <div className="bg-white p-6 rounded-lg shadow">
            <h2 className="text-xl font-semibold mb-4">Help Center</h2>
            <p>This is the help section. Content to be added.</p>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="bg-gray-100 min-h-screen">
      <div className="w-full pt-32 pb-12 px-4">
        <Header name={consultant.name} role={consultant.role} />
        <main className="grid grid-cols-12 gap-6 mt-6">
          <Sidebar
            activeSection={activeSection}
            setActiveSection={setActiveSection}
          />
          <section className="col-span-10">{renderContent()}</section>
        </main>
      </div>
    </div>
  );
}

// Helper function to get badge style (copied from AppointmentCard)
function getBadgeStyle(badge: string) {
  if (badge === 'Completed') {
    return 'bg-gray-400 text-white';
  }
  if (badge.includes('5 min')) {
    return 'bg-red-500 text-white';
  }
  if (badge.includes('2 hours')) {
    return 'bg-blue-500 text-white';
  }
  if (badge === 'Tomorrow') {
    return 'bg-purple-500 text-white';
  }
  if (badge.startsWith('In ')) {
    if (badge.includes('week')) {
      return 'bg-green-500 text-white';
    }
    if (badge.includes('month')) {
      return 'bg-yellow-500 text-white';
    }
    if (badge.includes('year')) {
      return 'bg-orange-500 text-white';
    }
    return 'bg-gray-500 text-white'; // For "In X days"
  }
  return 'bg-gray-400 text-white';
}
