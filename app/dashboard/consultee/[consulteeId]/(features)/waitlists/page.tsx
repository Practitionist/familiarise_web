"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import {
  Clock,
  Calendar,
  Users,
  Loader2,
  Bell,
  Trash2,
  ExternalLink,
} from "lucide-react";
import { WaitlistBadge } from "@/components/waitlist/WaitlistBadge";
import { SlotAvailableModal } from "@/components/waitlist/SlotAvailableModal";
import { format } from "date-fns";

interface WaitlistEntry {
  id: string;
  status: "WAITING" | "NOTIFIED";
  position: number | null;
  joinedAt: string;
  notifiedAt: string | null;
  expiresAt: string | null;
  webinar?: {
    id: string;
    webinarPlan: {
      id: string;
      title: string;
      price: number;
      consultantProfile?: {
        user: {
          name: string | null;
          image: string | null;
        };
      };
    };
    appointment?: {
      slotsOfAppointment?: Array<{
        startsAt: string;
      }>;
    };
  };
  class?: {
    id: string;
    classPlan: {
      id: string;
      title: string;
      price: number;
      consultantProfile?: {
        user: {
          name: string | null;
          image: string | null;
        };
      };
    };
    appointments?: Array<{
      slotsOfAppointment?: Array<{
        startsAt: string;
      }>;
    }>;
  };
}

const staggerChildren = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.08 },
  },
};

const fadeInUp = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
};

export default function WaitlistsPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(true);
  const [entries, setEntries] = useState<{
    webinars: WaitlistEntry[];
    classes: WaitlistEntry[];
  }>({ webinars: [], classes: [] });
  const [leavingId, setLeavingId] = useState<string | null>(null);
  const [selectedNotifiedEntry, setSelectedNotifiedEntry] =
    useState<WaitlistEntry | null>(null);

  useEffect(() => {
    const fetchWaitlists = async () => {
      try {
        const response = await fetch("/api/waitlist");
        const result = await response.json();

        if (result.success) {
          setEntries(result.data);

          // Check for any NOTIFIED entries and show modal
          const notifiedEntry = [...result.data.webinars, ...result.data.classes].find(
            (e: WaitlistEntry) => e.status === "NOTIFIED"
          );
          if (notifiedEntry) {
            setSelectedNotifiedEntry(notifiedEntry);
          }
        }
      } catch (error) {
        console.error("Error fetching waitlists:", error);
        toast({
          title: "Error",
          description: "Failed to load your waitlists",
          variant: "destructive",
        });
      } finally {
        setIsLoading(false);
      }
    };

    fetchWaitlists();
  }, [toast]);

  const handleLeaveWaitlist = async (waitlistId: string) => {
    setLeavingId(waitlistId);

    try {
      const response = await fetch(`/api/waitlist/${waitlistId}`, {
        method: "DELETE",
      });

      const result = await response.json();

      if (result.success) {
        // Remove from local state
        setEntries((prev) => ({
          webinars: prev.webinars.filter((e) => e.id !== waitlistId),
          classes: prev.classes.filter((e) => e.id !== waitlistId),
        }));
        toast({
          title: "Left waitlist",
          description: "You have been removed from the waitlist",
          variant: "success",
        });
      } else {
        toast({
          title: "Error",
          description: result.error || "Failed to leave waitlist",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Error",
        description: "Failed to leave waitlist",
        variant: "destructive",
      });
    } finally {
      setLeavingId(null);
    }
  };

  const renderEntry = (entry: WaitlistEntry, type: "webinar" | "class") => {
    const isNotified = entry.status === "NOTIFIED";
    const eventData = type === "webinar" ? entry.webinar : entry.class;
    const plan =
      type === "webinar" ? entry.webinar?.webinarPlan : entry.class?.classPlan;
    const consultant = plan?.consultantProfile?.user;

    const scheduledDate =
      type === "webinar"
        ? entry.webinar?.appointment?.slotsOfAppointment?.[0]?.startsAt
        : entry.class?.appointments?.[0]?.slotsOfAppointment?.[0]?.startsAt;

    if (!eventData || !plan) return null;

    return (
      <motion.div key={entry.id} variants={fadeInUp}>
        <Card
          className={`${
            isNotified ? "border-green-300 bg-green-50/50" : ""
          } hover:shadow-md transition-shadow`}
        >
          <CardContent className="p-4">
            <div className="flex items-start gap-4">
              <Avatar className="h-12 w-12">
                <AvatarImage
                  src={consultant?.image || undefined}
                  alt={consultant?.name || "Consultant"}
                />
                <AvatarFallback className="bg-zinc-100 text-zinc-600">
                  {consultant?.name
                    ?.split(" ")
                    .map((n) => n[0])
                    .join("")
                    .slice(0, 2) || "??"}
                </AvatarFallback>
              </Avatar>

              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-semibold text-gray-900 truncate">
                      {plan.title}
                    </h3>
                    <p className="text-sm text-gray-500">
                      with {consultant?.name || "Consultant"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {isNotified ? (
                      <Badge className="bg-green-100 text-green-800 border-green-300">
                        <Bell className="h-3 w-3 mr-1" />
                        Spot Available!
                      </Badge>
                    ) : (
                      <WaitlistBadge
                        position={entry.position}
                        variant="extended"
                      />
                    )}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-gray-500">
                  <Badge
                    variant="outline"
                    className="text-xs font-normal capitalize"
                  >
                    {type}
                  </Badge>

                  {scheduledDate && (
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3.5 w-3.5" />
                      {format(new Date(scheduledDate), "MMM d, yyyy 'at' h:mm a")}
                    </span>
                  )}

                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    Joined {format(new Date(entry.joinedAt), "MMM d, yyyy")}
                  </span>
                </div>

                {isNotified && entry.expiresAt && (
                  <div className="mt-3 p-3 bg-green-100 rounded-lg">
                    <p className="text-sm text-green-800 font-medium">
                      A spot is available! Book before{" "}
                      {format(
                        new Date(entry.expiresAt),
                        "MMM d, yyyy 'at' h:mm a"
                      )}
                    </p>
                  </div>
                )}

                <div className="mt-4 flex items-center gap-2">
                  {isNotified ? (
                    <Button
                      size="sm"
                      className="bg-green-600 hover:bg-green-700"
                      onClick={() => setSelectedNotifiedEntry(entry)}
                    >
                      <ExternalLink className="h-4 w-4 mr-2" />
                      Book Now
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        router.push(
                          `/explore/programs/plans/${type}s/${plan.id}`
                        )
                      }
                    >
                      <ExternalLink className="h-4 w-4 mr-2" />
                      View Event
                    </Button>
                  )}

                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-red-600 hover:text-red-700 hover:bg-red-50"
                    onClick={() => handleLeaveWaitlist(entry.id)}
                    disabled={leavingId === entry.id}
                  >
                    {leavingId === entry.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Trash2 className="h-4 w-4 mr-1" />
                        Leave
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
      </div>
    );
  }

  const totalEntries = entries.webinars.length + entries.classes.length;

  return (
    <motion.div
      variants={staggerChildren}
      initial="hidden"
      animate="visible"
      className="space-y-6"
    >
      {/* Header */}
      <motion.div variants={fadeInUp}>
        <Card>
          <CardHeader>
            <div className="flex items-center gap-4">
              <div className="h-12 w-12 rounded-lg bg-amber-100 flex items-center justify-center">
                <Users className="h-6 w-6 text-amber-600" />
              </div>
              <div>
                <CardTitle>My Waitlists</CardTitle>
                <CardDescription>
                  {totalEntries > 0
                    ? `You're on ${totalEntries} waitlist${
                        totalEntries > 1 ? "s" : ""
                      }`
                    : "You're not on any waitlists"}
                </CardDescription>
              </div>
            </div>
          </CardHeader>
        </Card>
      </motion.div>

      {totalEntries === 0 ? (
        <motion.div variants={fadeInUp}>
          <Card>
            <CardContent className="py-16 text-center">
              <div className="mx-auto h-16 w-16 rounded-2xl bg-gray-100 flex items-center justify-center mb-4">
                <Clock className="h-8 w-8 text-gray-400" />
              </div>
              <h3 className="font-semibold text-gray-900 text-lg">
                No Waitlist Entries
              </h3>
              <p className="text-sm text-gray-500 mt-1 mb-5">
                When events are full, you can join the waitlist to be notified
                when spots open up.
              </p>
              <Button onClick={() => router.push("/explore")}>
                Browse Events
              </Button>
            </CardContent>
          </Card>
        </motion.div>
      ) : (
        <>
          {/* Webinars */}
          {entries.webinars.length > 0 && (
            <motion.div variants={fadeInUp}>
              <h2 className="text-lg font-semibold text-gray-900 mb-4">
                Webinars ({entries.webinars.length})
              </h2>
              <div className="space-y-4">
                {entries.webinars.map((entry) => renderEntry(entry, "webinar"))}
              </div>
            </motion.div>
          )}

          {/* Classes */}
          {entries.classes.length > 0 && (
            <motion.div variants={fadeInUp}>
              <h2 className="text-lg font-semibold text-gray-900 mb-4">
                Classes ({entries.classes.length})
              </h2>
              <div className="space-y-4">
                {entries.classes.map((entry) => renderEntry(entry, "class"))}
              </div>
            </motion.div>
          )}
        </>
      )}

      {/* Slot Available Modal */}
      {selectedNotifiedEntry && (
        <SlotAvailableModal
          isOpen={!!selectedNotifiedEntry}
          onClose={() => setSelectedNotifiedEntry(null)}
          waitlistId={selectedNotifiedEntry.id}
          eventTitle={
            selectedNotifiedEntry.webinar?.webinarPlan.title ||
            selectedNotifiedEntry.class?.classPlan.title ||
            "Event"
          }
          eventType={selectedNotifiedEntry.webinar ? "webinar" : "class"}
          scheduledDate={
            selectedNotifiedEntry.webinar?.appointment?.slotsOfAppointment?.[0]
              ?.startsAt ||
            selectedNotifiedEntry.class?.appointments?.[0]
              ?.slotsOfAppointment?.[0]?.startsAt
          }
          expiresAt={selectedNotifiedEntry.expiresAt}
        />
      )}
    </motion.div>
  );
}
