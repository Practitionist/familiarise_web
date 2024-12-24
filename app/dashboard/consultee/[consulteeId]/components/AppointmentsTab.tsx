"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useEvents,
  ConsultationWithPlan,
  SubscriptionWithPlan,
  WebinarWithPlan,
  ClassWithPlan,
} from "@/hooks/useEvents";
import { motion } from "framer-motion";
import React from "react";

type EventWithType =
  | (ConsultationWithPlan & { type: "Consultation" })
  | (SubscriptionWithPlan & { type: "Subscription" })
  | (WebinarWithPlan & { type: "Webinar" })
  | (ClassWithPlan & { type: "Class" });

export default function AppointmentsTab({
  consulteeId,
}: {
  consulteeId: string;
}) {
  const { consultations, subscriptions, webinars, classes, isLoading, error } =
    useEvents(consulteeId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-pulse text-gray-500">
          Loading appointments...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 text-red-600 rounded-lg">
        Error loading appointments: {error.message}
      </div>
    );
  }

  if (
    !consultations.length &&
    !subscriptions.length &&
    !webinars.length &&
    !classes.length
  ) {
    return <div>No appointments found</div>;
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
  consultations: ConsultationWithPlan[];
  subscriptions: SubscriptionWithPlan[];
  webinars: WebinarWithPlan[];
  classes: ClassWithPlan[];
}) {
  return (
    <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
      <DashboardCard
        title="Consultations"
        items={consultations.map((consultation) => ({
          title: consultation.consultationPlan.title,
          consultant:
            consultation.consultationPlan.consultantProfile?.user?.name ||
            "Unknown Consultant",
          date: consultation.preferredDateTime
            ? new Date(consultation.preferredDateTime).toLocaleString()
            : "Unknown Date",
          image: consultation.consultationPlan.consultantProfile?.user?.image,
          status: consultation.requestStatus,
        }))}
      />
      <DashboardCard
        title="Subscriptions"
        items={subscriptions.map((subscription) => ({
          title: subscription.subscriptionPlan.title,
          consultant:
            subscription.subscriptionPlan.consultantProfile?.user?.name ||
            "Unknown Consultant",
          date: subscription.startDate
            ? new Date(subscription.startDate).toLocaleString()
            : "Unknown Date",
          image: subscription.subscriptionPlan.consultantProfile?.user?.image,
          status: subscription.requestStatus,
        }))}
      />
      <DashboardCard
        title="Classes"
        items={classes.map((classItem) => ({
          title: classItem.classPlan.title,
          consultant:
            classItem.classPlan.consultantProfile?.user?.name ||
            "Unknown Consultant",
          date: classItem.startDate
            ? new Date(classItem.startDate).toLocaleString()
            : "Unknown Date",
          image: classItem.classPlan.consultantProfile?.user?.image,
          status: classItem.status,
        }))}
      />
      <DashboardCard
        title="Webinars"
        items={webinars.map((webinar) => ({
          title: webinar.webinarPlan.title,
          consultant:
            webinar.webinarPlan.consultantProfile?.user?.name ||
            "Unknown Consultant",
          date: webinar.scheduledAt
            ? new Date(webinar.scheduledAt).toLocaleString()
            : "Unknown Date",
          image: webinar.webinarPlan.consultantProfile?.user?.image,
          status: webinar.status,
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
  consultations: ConsultationWithPlan[];
  subscriptions: SubscriptionWithPlan[];
  webinars: WebinarWithPlan[];
  classes: ClassWithPlan[];
}) {
  return (
    <div className="space-y-8">
      <Section title="Upcoming Consultations">
        {consultations.map((consultation) => (
          <ConsultationCard
            key={consultation.id}
            title={consultation.consultationPlan.title}
            consultant={
              consultation.consultationPlan.consultantProfile?.user?.name ||
              "Unknown Consultant"
            }
            date={
              consultation.preferredDateTime
                ? new Date(consultation.preferredDateTime).toLocaleString()
                : "Unknown Date"
            }
            image={consultation.consultationPlan.consultantProfile?.user?.image}
            buttonText="Join"
          />
        ))}
      </Section>
      <Section title="Subscriptions">
        {subscriptions.map((subscription) => (
          <ConsultationCard
            key={subscription.id}
            title={subscription.subscriptionPlan.title}
            consultant={
              subscription.subscriptionPlan.consultantProfile?.user?.name ||
              "Unknown Consultant"
            }
            date={
              subscription.startDate
                ? new Date(subscription.startDate).toLocaleString()
                : "Unknown Date"
            }
            image={subscription.subscriptionPlan.consultantProfile?.user?.image}
            buttonText="View"
          />
        ))}
      </Section>
      <Section title="Classes">
        {classes.map((classItem) => (
          <ConsultationCard
            key={classItem.id}
            title={classItem.classPlan.title}
            consultant={
              classItem.classPlan.consultantProfile?.user?.name ||
              "Unknown Consultant"
            }
            date={
              classItem.startDate
                ? new Date(classItem.startDate).toLocaleString()
                : "Unknown Date"
            }
            image={classItem.classPlan.consultantProfile?.user?.image}
            buttonText="Join"
          />
        ))}
      </Section>
      <Section title="Webinars">
        {webinars.map((webinar) => (
          <ConsultationCard
            key={webinar.id}
            title={webinar.webinarPlan.title}
            consultant={
              webinar.webinarPlan.consultantProfile?.user?.name ||
              "Unknown Consultant"
            }
            date={
              webinar.scheduledAt
                ? new Date(webinar.scheduledAt).toLocaleString()
                : "Unknown Date"
            }
            image={webinar.webinarPlan.consultantProfile?.user?.image}
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
  items: {
    title: string;
    date: string;
    consultant: string;
    status?: string;
    image?: string | null;
  }[];
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
              <div className="flex items-center space-x-4 bg-white">
                <Avatar className="bg-white">
                  <AvatarImage
                    src={item.image || "/placeholder.svg"}
                    alt={item.consultant}
                  />
                  <AvatarFallback className="bg-white">
                    {item.consultant.charAt(0)}
                  </AvatarFallback>
                </Avatar>
                <div>
                  <div className="font-medium bg-white">{item.title}</div>
                  <div className="text-sm text-muted-foreground bg-white">
                    {item.date}
                  </div>
                  <div className="text-sm text-muted-foreground bg-white">
                    {item.consultant}
                  </div>
                </div>
              </div>
              {item.status && (
                <Badge
                  variant={
                    item.status.toLowerCase() === "completed"
                      ? "default"
                      : item.status.toLowerCase() === "rejected"
                        ? "destructive"
                        : item.status.toLowerCase() === "pending"
                          ? "secondary"
                          : "default"
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
  image,
}: {
  title: string;
  consultant: string;
  date: string;
  buttonText: string;
  image?: string | null;
}) {
  return (
    <Card className="bg-white">
      <CardContent className="p-6 bg-white">
        <div className="flex items-center space-x-4 mb-4 bg-white">
          <Avatar className="bg-white">
            <AvatarImage src={image || "/placeholder.svg"} alt={consultant} />
            <AvatarFallback className="bg-white">
              {consultant.charAt(0)}
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
