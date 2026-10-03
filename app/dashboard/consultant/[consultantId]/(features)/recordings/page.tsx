"use client";

import { use } from "react";
import {
  DashboardHeader,
  DashboardContent,
} from "@/components/dashboard/PageScaffold";
import { UrlTabs } from "@/components/dashboard/UrlTabs";
import { RecordingsList } from "./components/RecordingsList";

interface RecordingsPageProps {
  params: Promise<{
    consultantId: string;
  }>;
}

export default function RecordingsPage({
  params,
}: Readonly<RecordingsPageProps>) {
  const { consultantId } = use(params);

  return (
    <>
      <DashboardHeader
        title="Recordings"
        subtitle="Manage your session recordings and replay listings"
      />
      <DashboardContent>
        <UrlTabs
          tabs={[
            {
              value: "all",
              label: "All",
              content: <RecordingsList consultantId={consultantId} />,
            },
            {
              value: "webinar",
              label: "Webinars",
              content: (
                <RecordingsList consultantId={consultantId} type="webinar" />
              ),
            },
            {
              value: "class",
              label: "Classes",
              content: (
                <RecordingsList consultantId={consultantId} type="class" />
              ),
            },
            {
              value: "consultation",
              label: "Consultations",
              content: (
                <RecordingsList
                  consultantId={consultantId}
                  type="consultation"
                />
              ),
            },
            {
              value: "subscription",
              label: "Subscriptions",
              content: (
                <RecordingsList
                  consultantId={consultantId}
                  type="subscription"
                />
              ),
            },
          ]}
        />
      </DashboardContent>
    </>
  );
}
