"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEvents } from "@/hooks/useEvents";
import { Class, Consultation, Subscription, Webinar } from "@prisma/client";
import { motion } from "framer-motion";
import React from "react";

type EventWithType =
  | (Consultation & { type: "Consultation" })
  | (Subscription & { type: "Subscription" })
  | (Webinar & { type: "Webinar" })
  | (Class & { type: "Class" });

export default function AppointmentsTab({
  consulteeId,
}: {
  consulteeId: string;
}) {
  const { consultations, subscriptions, webinars, classes, isLoading, error } =
    useEvents(consulteeId);

  if (isLoading) {
    return <div>Loading appointments...</div>;
  }

  if (error) {
    return <div>Error loading appointments: {error.message}</div>;
  }

  return (
    <div className="space-y-8 min-h-[calc(100vh-200px)]">
      <h2 className="text-3xl font-bold">Consultee Appointments</h2>
      <Tabs defaultValue="overview" className="space-y-8">
        <TabsList className="grid w-full grid-cols-3 lg:w-[400px] rounded-lg overflow-hidden">
          <TabsTrigger
            value="overview"
            className="data-[state=active]:bg-black data-[state=active]:text-white border-t border-l border-b rounded-tl-lg rounded-bl-lg"
          >
            Overview
          </TabsTrigger>
          <TabsTrigger
            value="upcoming"
            className="data-[state=active]:bg-black data-[state=active]:text-white border-t border-b"
          >
            Upcoming
          </TabsTrigger>
          <TabsTrigger
            value="calendar"
            className="data-[state=active]:bg-black data-[state=active]:text-white border-t border-r border-b rounded-tr-lg rounded-br-lg"
          >
            Calendar
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="space-y-8 rounded-lg">
          <Overview
            consultations={consultations}
            subscriptions={subscriptions}
            webinars={webinars}
            classes={classes}
          />
        </TabsContent>
        <TabsContent value="upcoming" className="space-y-8 rounded-lg">
          <Upcoming
            consultations={consultations}
            subscriptions={subscriptions}
            webinars={webinars}
            classes={classes}
          />
        </TabsContent>
        <TabsContent value="calendar" className="space-y-8 rounded-lg">
          <Calendar />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Overview({
  consultations,
  subscriptions,
  webinars,
  classes,
}: {
  consultations: Consultation[];
  subscriptions: Subscription[];
  webinars: Webinar[];
  classes: Class[];
}) {
  const allAppointments: EventWithType[] = [
    ...consultations.map((c) => ({ ...c, type: "Consultation" as const })),
    ...subscriptions.map((s) => ({ ...s, type: "Subscription" as const })),
    ...webinars.map((w) => ({ ...w, type: "Webinar" as const })),
    ...classes.map((c) => ({ ...c, type: "Class" as const })),
  ].sort((a, b) => {
    const dateA = getAppointmentDate(a);
    const dateB = getAppointmentDate(b);
    return new Date(dateA).getTime() - new Date(dateB).getTime();
  });

  const upcomingAppointments = allAppointments.slice(0, 5);

  return (
    <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
      <DashboardCard
        title="Consultations"
        items={consultations.map((consultation) => ({
          title: "Consultation",
          consultant: "Unknown Consultant",
          date: consultation.preferredDateTime
            ? new Date(consultation.preferredDateTime).toLocaleString()
            : "Unknown Date",
        }))}
      />
      <DashboardCard
        title="Subscriptions"
        items={subscriptions.map((subscription) => ({
          title: "Subscription",
          consultant: "Unknown Consultant",
          date: subscription.startDate
            ? new Date(subscription.startDate).toLocaleString()
            : "Unknown Date",
        }))}
      />
      <DashboardCard
        title="Classes"
        items={classes.map((classItem) => ({
          title: "Class",
          consultant: "Unknown Consultant",
          date: classItem.startDate
            ? new Date(classItem.startDate).toLocaleString()
            : "Unknown Date",
        }))}
      />
      <DashboardCard
        title="Webinars"
        items={webinars.map((webinar) => ({
          title: "Webinar",
          consultant: "Unknown Consultant",
          date: webinar.scheduledAt
            ? new Date(webinar.scheduledAt).toLocaleString()
            : "Unknown Date",
        }))}
      />
    </div>
  );
}

function Upcoming({
  consultations,
  subscriptions,
  webinars,
  classes,
}: {
  consultations: Consultation[];
  subscriptions: Subscription[];
  webinars: Webinar[];
  classes: Class[];
}) {
  return (
    <div className="space-y-8">
      <Section title="Upcoming Consultations">
        {consultations.map((consultation) => (
          <ConsultationCard
            key={consultation.id}
            title="Consultation"
            consultant="Unknown Consultant"
            date={
              consultation.preferredDateTime
                ? new Date(consultation.preferredDateTime).toLocaleString()
                : "Unknown Date"
            }
            buttonText="Join"
          />
        ))}
      </Section>
      <Section title="Subscriptions">
        {subscriptions.map((subscription) => (
          <ConsultationCard
            key={subscription.id}
            title="Subscription"
            consultant="Unknown Consultant"
            date={
              subscription.startDate
                ? new Date(subscription.startDate).toLocaleString()
                : "Unknown Date"
            }
            buttonText="View"
          />
        ))}
      </Section>
      <Section title="Classes">
        {classes.map((classItem) => (
          <ConsultationCard
            key={classItem.id}
            title="Class"
            consultant="Unknown Consultant"
            date={
              classItem.startDate
                ? new Date(classItem.startDate).toLocaleString()
                : "Unknown Date"
            }
            buttonText="Join"
          />
        ))}
      </Section>
      <Section title="Webinars">
        {webinars.map((webinar) => (
          <ConsultationCard
            key={webinar.id}
            title="Webinar"
            consultant="Unknown Consultant"
            date={
              webinar.scheduledAt
                ? new Date(webinar.scheduledAt).toLocaleString()
                : "Unknown Date"
            }
            buttonText="Join"
          />
        ))}
      </Section>
    </div>
  );
}

function Calendar() {
  return (
    <div className="bg-card text-card-foreground bg-white rounded-lg p-6">
      <h2 className="text-2xl font-semibold mb-4">Calendar View</h2>
      <p className="text-muted-foreground">
        Calendar integration coming soon...
      </p>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-2xl font-semibold mb-4">{title}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}

function DashboardCard({
  title,
  items,
}: {
  title: string;
  items: { title: string; date: string; consultant: string; status?: string }[];
}) {
  return (
    <Card className="bg-white">
      <CardHeader className="bg-white">
        <CardTitle className="text-lg font-semibold bg-white">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="bg-white">
        <div className="space-y-4 bg-white">
          {items.map((item, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
              className="flex items-center justify-between bg-white"
            >
              <div>
                <div className="font-medium bg-white">{item.title}</div>
                <div className="text-sm text-muted-foreground bg-white">
                  {item.date}
                </div>
                <div className="text-sm text-muted-foreground bg-white">
                  {item.consultant}
                </div>
              </div>
              {item.status && (
                <Badge
                  variant={
                    item.status.includes("Not") ? "secondary" : "default"
                  }
                  className="bg-white"
                >
                  {item.status}
                </Badge>
              )}
            </motion.div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ConsultationCard({
  title,
  consultant,
  date,
  buttonText,
}: {
  title: string;
  consultant: string;
  date: string;
  buttonText: string;
}) {
  return (
    <Card className="bg-white">
      <CardContent className="p-6 bg-white">
        <div className="flex items-center space-x-4 mb-4 bg-white">
          <Avatar className="bg-white">
            <AvatarFallback className="bg-white">
              {consultant
                .split(" ")
                .map((n) => n[0])
                .join("")}
            </AvatarFallback>
          </Avatar>
          <div className="bg-white">
            <h3 className="font-semibold bg-white">{title}</h3>
            <p className="text-sm text-muted-foreground bg-white">
              {consultant}
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between bg-white">
          <div className="text-sm text-muted-foreground bg-white">{date}</div>
          <Button size="sm" className="bg-black text-white">
            {buttonText}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function getAppointmentDate(appointment: EventWithType): string {
  switch (appointment.type) {
    case "Consultation":
      return appointment.preferredDateTime
        ? new Date(appointment.preferredDateTime).toLocaleString()
        : "Unknown Date";
    case "Subscription":
      return appointment.startDate
        ? new Date(appointment.startDate).toLocaleString()
        : "Unknown Date";
    case "Webinar":
      return appointment.scheduledAt
        ? new Date(appointment.scheduledAt).toLocaleString()
        : "Unknown Date";
    case "Class":
      return appointment.startDate
        ? new Date(appointment.startDate).toLocaleString()
        : "Unknown Date";
  }
}
