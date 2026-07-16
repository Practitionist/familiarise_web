"use client";

import { use, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Video, Play, GraduationCap } from "lucide-react";
import { RecordingsList } from "./components/RecordingsList";

interface RecordingsPageProps {
  params: Promise<{
    consultantId: string;
  }>;
}

export default function RecordingsPage({ params }: RecordingsPageProps) {
  const { consultantId } = use(params);
  const [activeTab, setActiveTab] = useState<"all" | "webinar" | "class">(
    "all",
  );

  return (
    <div className="container py-8 space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-primary/10 rounded-lg">
          <Video className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Recordings</h1>
          <p className="text-muted-foreground">
            Manage your webinar and class recordings
          </p>
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as "all" | "webinar" | "class")}
        className="space-y-6"
      >
        <TabsList className="grid w-full max-w-full grid-cols-3 sm:max-w-[400px]">
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
      </Tabs>
    </div>
  );
}
