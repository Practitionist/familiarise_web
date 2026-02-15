"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { FolderOpen, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { EventResourceCard, type EventResource } from "./EventResourceCard";

interface ResourcesData {
  consultations: EventResource[];
  subscriptions: EventResource[];
  webinars: EventResource[];
  classes: EventResource[];
}

interface ResourcesTabProps {
  data: ResourcesData | undefined;
  onRefresh?: () => void;
}

const EVENT_TYPES = [
  { key: "consultations", label: "Consultations" },
  { key: "subscriptions", label: "Subscriptions" },
  { key: "webinars", label: "Webinars" },
  { key: "classes", label: "Classes" },
] as const;

export function ResourcesTab({ data, onRefresh }: ResourcesTabProps) {
  const { toast } = useToast();
  const [isSyncing, setIsSyncing] = useState(false);

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const response = await fetch("/api/stream/recordings/sync", {
        method: "POST",
      });
      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Failed to sync recordings");
      }

      if (result.synced > 0) {
        toast({
          title: "Synced",
          description: `${result.synced} recording(s) synced from Stream.`,
        });
        onRefresh?.();
      } else {
        toast({
          title: "Up to date",
          description: "No new recordings found.",
        });
      }
    } catch (err) {
      console.error("Error syncing recordings:", err);
      toast({
        title: "Error",
        description:
          err instanceof Error ? err.message : "Failed to sync recordings",
        variant: "destructive",
      });
    } finally {
      setIsSyncing(false);
    }
  };

  if (!data) return null;

  const totalResources =
    data.consultations.length +
    data.subscriptions.length +
    data.webinars.length +
    data.classes.length;

  if (totalResources === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col items-center justify-center min-h-[400px] p-8 bg-white rounded-xl shadow-sm"
      >
        <div className="w-16 h-16 mb-4 text-zinc-300 flex items-center justify-center">
          <FolderOpen className="w-12 h-12" />
        </div>
        <h3 className="text-xl font-semibold text-zinc-900 mb-2">
          No Resources Yet
        </h3>
        <p className="text-zinc-500 text-center max-w-md">
          Resources from your enrolled consultations, subscriptions, webinars,
          and classes will appear here. Book a session to get started!
        </p>
      </motion.div>
    );
  }

  // Find the first tab that has events
  const defaultTab =
    EVENT_TYPES.find(
      (t) => data[t.key as keyof ResourcesData].length > 0,
    )?.key || "consultations";

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Resources</h1>
          <p className="text-zinc-500 mt-1">
            Materials and recordings from your enrolled events
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleSync}
          disabled={isSyncing}
        >
          <RefreshCw
            className={`h-4 w-4 mr-2 ${isSyncing ? "animate-spin" : ""}`}
          />
          {isSyncing ? "Syncing..." : "Sync from Stream"}
        </Button>
      </div>

      <Tabs defaultValue={defaultTab} className="space-y-6">
        <TabsList>
          {EVENT_TYPES.map(({ key, label }) => {
            const count = data[key as keyof ResourcesData].length;
            return (
              <TabsTrigger key={key} value={key} disabled={count === 0}>
                {label}
                {count > 0 && (
                  <span className="ml-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-zinc-200 px-1.5 text-xs font-medium text-zinc-700">
                    {count}
                  </span>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {EVENT_TYPES.map(({ key }) => (
          <TabsContent key={key} value={key}>
            <div className="space-y-4">
              {data[key as keyof ResourcesData].map((event) => (
                <EventResourceCard key={event.id} event={event} />
              ))}
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </motion.div>
  );
}
