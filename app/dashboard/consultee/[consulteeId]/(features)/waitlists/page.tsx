"use client";

import { useEffect, useMemo, useState } from "react";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Clock,
  Calendar,
  Users,
  Loader2,
  Bell,
  Trash2,
  ExternalLink,
  ArrowUpDown,
  Info,
} from "lucide-react";
import { WaitlistBadge } from "@/components/waitlist/WaitlistBadge";
import { SlotAvailableModal } from "@/components/waitlist/SlotAvailableModal";
import { format, formatDistanceToNow } from "date-fns";

interface WaitlistEntry {
  id: string;
  status: "WAITING" | "NOTIFIED";
  position: number | null;
  totalWaiting?: number;
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

const getScheduledDate = (entry: WaitlistEntry): Date | null => {
  const dateStr =
    entry.webinar?.appointment?.slotsOfAppointment?.[0]?.startsAt ||
    entry.class?.appointments?.[0]?.slotsOfAppointment?.[0]?.startsAt;
  return dateStr ? new Date(dateStr) : null;
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
  const [leaveConfirmEntry, setLeaveConfirmEntry] =
    useState<WaitlistEntry | null>(null);
  const [filterType, setFilterType] = useState<"all" | "webinar" | "class">(
    "all",
  );
  const [sortOrder, setSortOrder] = useState<"soonest" | "position">(
    "soonest",
  );

  useEffect(() => {
    const fetchWaitlists = async () => {
      try {
        const response = await fetch("/api/waitlist");
        const result = await response.json();

        if (result.success) {
          setEntries(result.data);

          // Check for any NOTIFIED entries and show modal
          const notifiedEntry = [
            ...result.data.webinars,
            ...result.data.classes,
          ].find((e: WaitlistEntry) => e.status === "NOTIFIED");
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

  // Step 1 — Split into upcoming vs ended, sorted by date or position
  const { upcomingWebinars, endedWebinars, upcomingClasses, endedClasses } =
    useMemo(() => {
      const now = new Date();

      const splitAndSort = (items: WaitlistEntry[]) => {
        const upcoming = items
          .filter((e) => {
            const d = getScheduledDate(e);
            return !d || d >= now; // no date = treat as upcoming
          })
          .sort((a, b) => {
            if (sortOrder === "position") {
              const pa = a.position ?? Infinity;
              const pb = b.position ?? Infinity;
              return pa - pb;
            }
            const da = getScheduledDate(a)?.getTime() ?? Infinity;
            const db = getScheduledDate(b)?.getTime() ?? Infinity;
            return da - db; // soonest first
          });

        const ended = items
          .filter((e) => {
            const d = getScheduledDate(e);
            return d && d < now;
          })
          .sort((a, b) => {
            const da = getScheduledDate(a)!.getTime();
            const db = getScheduledDate(b)!.getTime();
            return db - da; // most recently ended first
          });

        return { upcoming, ended };
      };

      const w = splitAndSort(entries.webinars);
      const c = splitAndSort(entries.classes);
      return {
        upcomingWebinars: w.upcoming,
        endedWebinars: w.ended,
        upcomingClasses: c.upcoming,
        endedClasses: c.ended,
      };
    }, [entries, sortOrder]);

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

  const renderEntry = (
    entry: WaitlistEntry,
    type: "webinar" | "class",
    isPast: boolean,
  ) => {
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
            isPast
              ? "opacity-60 border-gray-200"
              : isNotified
                ? "border-green-300 bg-green-50/50"
                : ""
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
                    {isPast ? (
                      <Badge className="bg-red-100 text-red-800 border-red-300">
                        Event Ended
                      </Badge>
                    ) : isNotified ? (
                      <Badge className="bg-green-100 text-green-800 border-green-300">
                        <Bell className="h-3 w-3 mr-1" />
                        Spot Available!
                      </Badge>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <WaitlistBadge
                          position={entry.position}
                          variant="extended"
                        />
                        {entry.totalWaiting !== undefined && (
                          <span className="text-xs text-gray-400">
                            of {entry.totalWaiting}
                          </span>
                        )}
                      </div>
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
                      {format(
                        new Date(scheduledDate),
                        "MMM d, yyyy 'at' h:mm a",
                      )}
                    </span>
                  )}

                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    Joined {format(new Date(entry.joinedAt), "MMM d, yyyy")} (
                    {formatDistanceToNow(new Date(entry.joinedAt), {
                      addSuffix: false,
                    })}{" "}
                    ago)
                  </span>
                </div>

                {!isPast && isNotified && entry.expiresAt && (
                  <div className="mt-3 p-3 bg-green-100 rounded-lg">
                    <p className="text-sm text-green-800 font-medium">
                      A spot is available! Book before{" "}
                      {format(
                        new Date(entry.expiresAt),
                        "MMM d, yyyy 'at' h:mm a",
                      )}
                    </p>
                  </div>
                )}

                <div className="mt-4 flex items-center gap-2">
                  {isPast ? (
                    // Past entries: only show Remove button
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      onClick={() => setLeaveConfirmEntry(entry)}
                      disabled={leavingId === entry.id}
                    >
                      {leavingId === entry.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <>
                          <Trash2 className="h-4 w-4 mr-1" />
                          Remove
                        </>
                      )}
                    </Button>
                  ) : (
                    <>
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
                              `/explore/programs/plans/${type === "class" ? "classes" : "webinars"}/${plan.id}`,
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
                        onClick={() => setLeaveConfirmEntry(entry)}
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
                    </>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    );
  };

  const renderSection = (
    title: string,
    upcoming: WaitlistEntry[],
    ended: WaitlistEntry[],
    type: "webinar" | "class",
  ) => {
    if (upcoming.length === 0 && ended.length === 0) return null;

    return (
      <motion.div variants={fadeInUp}>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          {title} ({upcoming.length + ended.length})
        </h2>

        {upcoming.length > 0 && (
          <div className="space-y-4">
            {upcoming.map((entry) => renderEntry(entry, type, false))}
          </div>
        )}

        {ended.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
              Ended
            </h3>
            <div className="space-y-4">
              {ended.map((entry) => renderEntry(entry, type, true))}
            </div>
          </div>
        )}
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

      {/* Scope note */}
      <motion.div variants={fadeInUp}>
        <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50/60 px-4 py-3 text-sm text-blue-800">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <p>
            Waitlists are available for <strong>Webinars</strong> and{" "}
            <strong>Classes</strong>. For Consultations, you can book directly
            from the consultant&apos;s profile.
          </p>
        </div>
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
          {/* Filter & Sort Controls */}
          <motion.div variants={fadeInUp}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              {/* Filter pills */}
              <div className="flex items-center gap-2">
                {(
                  [
                    { value: "all", label: "All" },
                    { value: "webinar", label: "Webinars" },
                    { value: "class", label: "Classes" },
                  ] as const
                ).map(({ value, label }) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={filterType === value ? "default" : "outline"}
                    onClick={() => setFilterType(value)}
                    className="h-8"
                  >
                    {label}
                  </Button>
                ))}
              </div>

              {/* Sort toggle */}
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setSortOrder((prev) =>
                    prev === "soonest" ? "position" : "soonest",
                  )
                }
                className="h-8 gap-1.5"
              >
                <ArrowUpDown className="h-3.5 w-3.5" />
                {sortOrder === "soonest" ? "Date" : "Position"}
              </Button>
            </div>
          </motion.div>

          {/* Webinars */}
          {filterType !== "class" &&
            renderSection(
              "Webinars",
              upcomingWebinars,
              endedWebinars,
              "webinar",
            )}

          {/* Classes */}
          {filterType !== "webinar" &&
            renderSection(
              "Classes",
              upcomingClasses,
              endedClasses,
              "class",
            )}
        </>
      )}

      {/* Leave Confirmation Dialog */}
      <AlertDialog
        open={!!leaveConfirmEntry}
        onOpenChange={(open) => !open && setLeaveConfirmEntry(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave waitlist?</AlertDialogTitle>
            <AlertDialogDescription>
              You will lose your current position
              {leaveConfirmEntry?.position
                ? ` (#${leaveConfirmEntry.position})`
                : ""}{" "}
              on the waitlist for &quot;
              {leaveConfirmEntry?.webinar?.webinarPlan?.title ||
                leaveConfirmEntry?.class?.classPlan?.title}
              &quot;. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                handleLeaveWaitlist(leaveConfirmEntry!.id);
                setLeaveConfirmEntry(null);
              }}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              Leave Waitlist
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
