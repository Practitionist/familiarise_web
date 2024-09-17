"use client";

import React, { Suspense, useEffect, useState } from 'react';
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { AppointmentCard } from './components/AppointmentCard';
import { DocumentReviewTable } from './components/DocumentReviewTable';
import { ClientActivity } from './components/ClientActivity';
import { ApprovalsTable } from './components/ApprovalsTable';
import ChatUI from './components/ChatUI';
import {
  fetchConsultantData,
  fetchAppointments,
  fetchDocuments,
  fetchActivities,
  fetchApprovals,
  Consultant,
  Appointment,
  Document,
  Activity,
  Approval
} from './utils';

export default function ConsultantDashboard({ params }: { readonly params: { consultantId: string } }) {
  const consultantId = params.consultantId;
  const [activeSection, setActiveSection] = useState('Home');
  const [consultant, setConsultant] = useState<Consultant | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);

  useEffect(() => {
    if (consultantId) {
      fetchConsultantData(consultantId).then(setConsultant);
      fetchAppointments(consultantId).then(setAppointments);
      fetchDocuments(consultantId).then(setDocuments);
      fetchActivities(consultantId).then(setActivities);
      fetchApprovals(consultantId).then(setApprovals);
    }
  }, [consultantId]);

  if (!consultant) {
    return <div>Loading...</div>;
  }

  const renderContent = () => {
    switch (activeSection) {
      case 'Home':
        return (
          <div className="grid grid-cols-3 gap-6">
            <div className="col-span-2 space-y-6">
              <Suspense fallback={<div>Loading appointments...</div>}>
                <div className="bg-white p-6 rounded-lg shadow">
                  <h2 className="text-xl font-semibold mb-4">Today's Appointments</h2>
                  <div className="grid grid-cols-2 gap-4">
                    {appointments.slice(0, 2).map((appointment) => (
                      <AppointmentCard key={appointment.id} {...appointment} />
                    ))}
                  </div>
                </div>
              </Suspense>
              <Suspense fallback={<div>Loading upcoming appointments...</div>}>
                <div className="bg-white p-6 rounded-lg shadow">
                  <h2 className="text-xl font-semibold mb-4">Upcoming Appointments</h2>
                  <ul className="space-y-4">
                    {appointments.slice(2, 4).map(({ id, name, description, time, badge }) => (
                      <li key={id} className="flex items-center space-x-4">
                        <Avatar>
                          <AvatarImage alt={name} src="/placeholder.svg" />
                          <AvatarFallback>{name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
                        </Avatar>
                        <div className="flex-grow">
                          <h3 className="text-lg font-semibold">{name}</h3>
                          <p className="text-sm text-gray-500">{description}</p>
                          <p className="text-sm">{time}</p>
                          <Badge variant="secondary" className="bg-blue-500 text-white">{badge}</Badge>
                        </div>
                        <Button className="bg-blue-500 text-white">Chat</Button>
                      </li>
                    ))}
                  </ul>
                </div>
              </Suspense>
            </div>
            <div className="space-y-6">
              <Suspense fallback={<div>Loading client activity...</div>}>
                <div className="bg-white p-6 rounded-lg shadow">
                  <h2 className="text-xl font-semibold mb-4">Clients Activity</h2>
                  <ClientActivity activities={activities} />
                  <Button className="mt-4 w-full bg-blue-500 text-white">Login Report</Button>
                </div>
              </Suspense>
              <Suspense fallback={<div>Loading approvals...</div>}>
                <div className="bg-white p-6 rounded-lg shadow">
                  <h2 className="text-xl font-semibold mb-4">Approvals for Consultations and Subscriptions</h2>
                  <ApprovalsTable approvals={approvals.slice(0, 3)} />
                </div>
              </Suspense>
            </div>
          </div>
        );
      case 'Chats':
        return (
          <div className="bg-white rounded-lg shadow h-[calc(100vh-200px)]">
            <ChatUI />
          </div>
        );
      case 'Appointments':
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
                <li key={appointment.id} className="flex items-center justify-between p-4 bg-gray-100 rounded-lg">
                  <div className="flex items-center space-x-4">
                    <Avatar>
                      <AvatarImage alt={appointment.name} src="/placeholder.svg" />
                      <AvatarFallback>{appointment.name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
                    </Avatar>
                    <div>
                      <h3 className="font-semibold">{appointment.name}</h3>
                      <p className="text-sm text-gray-600">{appointment.description}</p>
                      <p className="text-sm text-gray-500">{appointment.time}</p>
                    </div>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Badge variant="secondary" className="bg-blue-500 text-white">{appointment.badge}</Badge>
                    <Button variant="default" className="bg-gray-400 text-white" disabled>Join meet</Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      case 'Requests':
        return (
          <div className="bg-white p-6 rounded-lg shadow">
            <h2 className="text-xl font-semibold mb-4">All Appointment Requests</h2>
            <ApprovalsTable approvals={approvals} />
          </div>
        );
      case 'Documents for Review':
        return (
          <div className="bg-white p-6 rounded-lg shadow">
            <h2 className="text-xl font-semibold mb-4">Documents For Review</h2>
            <DocumentReviewTable documents={documents} />
          </div>
        );
      case 'Help':
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
          <Sidebar activeSection={activeSection} setActiveSection={setActiveSection} />
          <section className="col-span-10">
            {renderContent()}
          </section>
        </main>
      </div>
    </div>
  );
}
