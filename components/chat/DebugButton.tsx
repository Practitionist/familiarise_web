"use client";

import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { useState } from "react";

interface DebugButtonProps {
  userId: string;
  variant?: "default" | "outline" | "ghost" | "secondary";
  className?: string;
}

export const DebugButton = ({ userId, variant = "outline", className = "w-full" }: DebugButtonProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const [debugData, setDebugData] = useState<any>(null);
  const { toast } = useToast();

  const handleDebug = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/stream/debug?userId=${userId}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      });

      const data = await response.json();

      if (data.success) {
        setDebugData(data);
        toast({
          title: "Debug data fetched successfully",
          description: `Found ${data.channels.length} channels, ${data.consultations.length} consultations, ${data.subscriptions.length} subscriptions, ${data.webinars.length} webinars, and ${data.classes.length} classes.`,
        });
      } else {
        toast({
          title: "Error fetching debug data",
          description: data.error || "An error occurred",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("Error fetching debug data:", error);
      toast({
        title: "Error fetching debug data",
        description: (error as Error).message || "An error occurred",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Button 
        onClick={handleDebug} 
        disabled={isLoading} 
        className={className}
        variant={variant}
      >
        {isLoading ? "Debugging..." : "Debug Stream Chat"}
      </Button>

      {debugData && (
        <div className="mt-4 p-4 bg-gray-100 rounded-lg">
          <h3 className="text-lg font-medium mb-2">Debug Results</h3>

          <div className="space-y-4">
            <div>
              <h4 className="font-medium">User</h4>
              <pre className="bg-white p-2 rounded text-xs overflow-auto">
                {JSON.stringify(debugData.user, null, 2)}
              </pre>
            </div>

            <div>
              <h4 className="font-medium">
                Channels ({debugData.channels.length})
              </h4>
              <pre className="bg-white p-2 rounded text-xs overflow-auto">
                {JSON.stringify(debugData.channels, null, 2)}
              </pre>
            </div>

            <div>
              <h4 className="font-medium">
                Consultations ({debugData.consultations.length})
              </h4>
              <pre className="bg-white p-2 rounded text-xs overflow-auto">
                {JSON.stringify(debugData.consultations, null, 2)}
              </pre>
            </div>

            <div>
              <h4 className="font-medium">
                Subscriptions ({debugData.subscriptions.length})
              </h4>
              <pre className="bg-white p-2 rounded text-xs overflow-auto">
                {JSON.stringify(debugData.subscriptions, null, 2)}
              </pre>
            </div>

            <div>
              <h4 className="font-medium">
                Webinars ({debugData.webinars.length})
              </h4>
              <pre className="bg-white p-2 rounded text-xs overflow-auto">
                {JSON.stringify(debugData.webinars, null, 2)}
              </pre>
            </div>

            <div>
              <h4 className="font-medium">
                Classes ({debugData.classes.length})
              </h4>
              <pre className="bg-white p-2 rounded text-xs overflow-auto">
                {JSON.stringify(debugData.classes, null, 2)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
