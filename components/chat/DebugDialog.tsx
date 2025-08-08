"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { useState } from "react";
import { Loader2 } from "lucide-react";

interface DebugDialogProps {
  userId: string;
  variant?: "default" | "outline" | "ghost" | "secondary";
  className?: string;
}

interface DebugData {
  success: boolean;
  user: any;
  channels: any[];
  consultations: any[];
  subscriptions: any[];
  webinars: any[];
  classes: any[];
}

export const DebugDialog = ({ userId, variant = "outline", className = "w-full" }: DebugDialogProps) => {
  const [isLoading, setIsLoading] = useState(false);
  const [debugData, setDebugData] = useState<DebugData | null>(null);
  const [isOpen, setIsOpen] = useState(false);
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
        setIsOpen(true);
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

  const DebugSection = ({ title, data }: { title: string; data: any }) => (
    <div className="space-y-2">
      <h4 className="font-semibold text-gray-900 dark:text-gray-100">{title}</h4>
      <div className="h-40 w-full rounded-md border bg-slate-50 dark:bg-slate-900 overflow-auto">
        <pre className="p-3 text-xs text-gray-800 dark:text-gray-200 font-mono">
          {JSON.stringify(data, null, 2)}
        </pre>
      </div>
    </div>
  );

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button 
          onClick={handleDebug} 
          disabled={isLoading} 
          className={className}
          variant={variant}
        >
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Debugging...
            </>
          ) : (
            "Debug Stream Chat"
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle>Stream Chat Debug Information</DialogTitle>
          <DialogDescription>
            Debug data for user ID: {userId}
          </DialogDescription>
        </DialogHeader>
        
        {debugData && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg">
                <div className="font-medium text-blue-900 dark:text-blue-100">Channels</div>
                <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">{debugData.channels.length}</div>
              </div>
              <div className="bg-green-50 dark:bg-green-900/20 p-3 rounded-lg">
                <div className="font-medium text-green-900 dark:text-green-100">Consultations</div>
                <div className="text-2xl font-bold text-green-600 dark:text-green-400">{debugData.consultations.length}</div>
              </div>
              <div className="bg-purple-50 dark:bg-purple-900/20 p-3 rounded-lg">
                <div className="font-medium text-purple-900 dark:text-purple-100">Subscriptions</div>
                <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">{debugData.subscriptions.length}</div>
              </div>
              <div className="bg-orange-50 dark:bg-orange-900/20 p-3 rounded-lg">
                <div className="font-medium text-orange-900 dark:text-orange-100">Webinars</div>
                <div className="text-2xl font-bold text-orange-600 dark:text-orange-400">{debugData.webinars.length}</div>
              </div>
              <div className="bg-pink-50 dark:bg-pink-900/20 p-3 rounded-lg">
                <div className="font-medium text-pink-900 dark:text-pink-100">Classes</div>
                <div className="text-2xl font-bold text-pink-600 dark:text-pink-400">{debugData.classes.length}</div>
              </div>
            </div>

            <div className="h-96 w-full overflow-auto">
              <div className="space-y-6 pr-4">
                <DebugSection title="User Information" data={debugData.user} />
                <DebugSection title={`Channels (${debugData.channels.length})`} data={debugData.channels} />
                <DebugSection title={`Consultations (${debugData.consultations.length})`} data={debugData.consultations} />
                <DebugSection title={`Subscriptions (${debugData.subscriptions.length})`} data={debugData.subscriptions} />
                <DebugSection title={`Webinars (${debugData.webinars.length})`} data={debugData.webinars} />
                <DebugSection title={`Classes (${debugData.classes.length})`} data={debugData.classes} />
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};