"use client";

import { use, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Video, Play, GraduationCap, User, Repeat } from "lucide-react";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { RecordingsList } from "./components/RecordingsList";

/**
 * Consultations and subscriptions used to be missing here, and from the query
 * behind it — a consultant could not watch back a 1:1 they had delivered,
 * while an operator at the sponsoring org could. See ADR 20.
 */
type RecordingTab =
  | "all"
  | "webinar"
  | "class"
  | "consultation"
  | "subscription";

interface RecordingsPageProps {
  params: Promise<{
    consultantId: string;
  }>;
}

export default function RecordingsPage({ params }: RecordingsPageProps) {
  const { consultantId } = use(params);
  const [activeTab, setActiveTab] = useState<RecordingTab>("all");

  return (
    <>
      <DashboardHeader
        title="Recordings"
        subtitle="Recordings of every session you delivered"
      />
      <DashboardContent>

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as RecordingTab)}
        className="space-y-6"
      >
        <TabsList className="grid w-full max-w-full grid-cols-3 sm:grid-cols-5 sm:max-w-[640px]">
          <TabsTrigger value="all" className="flex items-center gap-2">
            <Video className="w-4 h-4" />
            <span>All</span>
          </TabsTrigger>
          <TabsTrigger value="webinar" className="flex items-center gap-2">
            <Play className="w-4 h-4" />
            <span>Webinars</span>
          </TabsTrigger>
          <TabsTrigger value="class" className="flex items-center gap-2">
            <GraduationCap className="w-4 h-4" />
            <span>Classes</span>
          </TabsTrigger>
          <TabsTrigger value="consultation" className="flex items-center gap-2">
            <User className="w-4 h-4" />
            <span>Consultations</span>
          </TabsTrigger>
          <TabsTrigger value="subscription" className="flex items-center gap-2">
            <Repeat className="w-4 h-4" />
            <span>Subscriptions</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="all" className="mt-6">
          <RecordingsList consultantId={consultantId} />
        </TabsContent>

        <TabsContent value="webinar" className="mt-6">
          <RecordingsList consultantId={consultantId} type="webinar" />
        </TabsContent>

        <TabsContent value="class" className="mt-6">
          <RecordingsList consultantId={consultantId} type="class" />
        </TabsContent>

        <TabsContent value="consultation" className="mt-6">
          <RecordingsList consultantId={consultantId} type="consultation" />
        </TabsContent>

        <TabsContent value="subscription" className="mt-6">
          <RecordingsList consultantId={consultantId} type="subscription" />
        </TabsContent>
        </Tabs>
      </DashboardContent>
    </>
  );
}
