"use client";

import { useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";


import {
  ResponsiveModal,
  ResponsiveModalContent,
  ResponsiveModalDescription,
  ResponsiveModalFooter,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from "@/components/ui/responsive-modal";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { DashboardHeader } from "@/components/dashboard/PageScaffold";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Search,
  Flag,
  CheckCircle2,
  XCircle,
  Star,
  MessageSquare,
  User,
  FileText,
  Eye,
  ThumbsUp,
  ThumbsDown,
  Loader2,
  RefreshCw,
  ExternalLink,
  AlertTriangle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type {
  ProfileVerification,
  ModerationReport,
  ModerationReview,
  ModerationStats,
} from "@/types/moderation";

const getStatusColor = (status: string) => {
  switch (status.toLowerCase()) {
    case "pending":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
    case "resolved":
    case "approved":
    case "verified":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    case "rejected":
    case "dismissed":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    case "in_progress":
      return "bg-muted text-foreground";
    default:
      return "bg-muted text-muted-foreground";
  }
};

const getTypeIcon = (type: string) => {
  switch (type.toLowerCase()) {
    case "review":
      return <Star className="h-4 w-4" />;
    case "profile":
      return <User className="h-4 w-4" />;
    case "message":
    case "chat":
      return <MessageSquare className="h-4 w-4" />;
    default:
      return <FileText className="h-4 w-4" />;
  }
};

const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  return date.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export default function ContentModerationPage() {
  const [activeTab, setActiveTab] = useState("reports");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedReport, setSelectedReport] = useState<ModerationReport | null>(
    null,
  );
  const [selectedProfile, setSelectedProfile] =
    useState<ProfileVerification | null>(null);
  const [moderationNote, setModerationNote] = useState("");
  const [suspensionDays, setSuspensionDays] = useState(7);

  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Fetch moderation stats
  const {
    data: stats,
    isPending: loadingStats,
    isFetching: fetchingStats,
    refetch: refetchStats,
  } = useQuery({
    queryKey: ["staff-moderation-stats"],
    queryFn: async (): Promise<ModerationStats> => {
      const response = await fetch("/api/staff/moderation/stats");
      if (!response.ok) throw new Error("Failed to fetch stats");
      return response.json();
    },
  });

  // Fetch moderation reports
  const {
    data: reportsData,
    isPending: loadingReports,
    isFetching: fetchingReports,
    isError: reportsError,
    refetch: refetchReports,
  } = useQuery({
    queryKey: ["staff-moderation-reports", "PENDING"],
    queryFn: async (): Promise<{ reports: ModerationReport[] }> => {
      const response = await fetch(
        "/api/staff/moderation/reports?status=PENDING",
      );
      if (!response.ok) throw new Error("Failed to fetch reports");
      return response.json();
    },
    placeholderData: keepPreviousData,
  });
  const reports = reportsData?.reports ?? [];

  // Fetch profile verifications
  const {
    data: profilesData,
    isPending: loadingProfiles,
    isFetching: fetchingProfiles,
    isError: profilesError,
    refetch: refetchProfiles,
  } = useQuery({
    queryKey: ["staff-moderation-profiles", "PENDING"],
    queryFn: async (): Promise<{ verifications: ProfileVerification[] }> => {
      const response = await fetch(
        "/api/staff/moderation/profiles?status=PENDING",
      );
      if (!response.ok) throw new Error("Failed to fetch profiles");
      return response.json();
    },
    placeholderData: keepPreviousData,
  });
  const profiles = profilesData?.verifications ?? [];

  // Fetch reviews
  const {
    data: reviewsData,
    isPending: loadingReviews,
    isFetching: fetchingReviews,
    isError: reviewsError,
    refetch: refetchReviews,
  } = useQuery({
    queryKey: ["staff-moderation-reviews", 10],
    queryFn: async (): Promise<{ reviews: ModerationReview[] }> => {
      const response = await fetch("/api/staff/moderation/reviews?limit=10");
      if (!response.ok) throw new Error("Failed to fetch reviews");
      return response.json();
    },
    placeholderData: keepPreviousData,
  });
  const reviews = reviewsData?.reviews ?? [];

  const isRefreshing =
    fetchingStats || fetchingReports || fetchingProfiles || fetchingReviews;

  const handleRefreshAll = () => {
    refetchStats();
    refetchReports();
    refetchProfiles();
    refetchReviews();
  };

  // Handle report action (dismiss or take action). UI verbs map to the
  // ModerationActionType enum the API validates against (#693).
  const REPORT_ACTION_TYPE = {
    DISMISS: "NO_ACTION",
    WARN: "WARNING_ISSUED",
    SUSPEND: "USER_SUSPENDED",
    BAN: "USER_BANNED",
  } as const;

  const reportActionMutation = useMutation({
    mutationFn: async ({
      reportId,
      action,
    }: {
      reportId: string;
      action: "DISMISS" | "WARN" | "SUSPEND" | "BAN";
    }) => {
      const response = await fetch(
        `/api/staff/moderation/reports/${reportId}/action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actionType: REPORT_ACTION_TYPE[action],
            notes: moderationNote,
            ...(action === "SUSPEND" ? { suspensionDays } : {}),
          }),
        },
      );

      if (!response.ok) throw new Error("Failed to process action");
      return response.json() as Promise<{
        sideEffects?: {
          sessionsRevoked?: number;
          earningsHeld?: number;
          cancellations?: {
            engagementsCancelled: number;
            refundsIssued: number;
          };
        };
      }>;
    },
    onSuccess: (data, { action }) => {
      const cancelled = data?.sideEffects?.cancellations?.engagementsCancelled;
      const refunded = data?.sideEffects?.cancellations?.refundsIssued;
      const detail =
        cancelled || refunded
          ? ` ${cancelled ?? 0} appointment(s) cancelled, ${refunded ?? 0} refund(s) issued.`
          : "";
      toast({
        title: "Action Completed",
        description: `Report has been ${action === "DISMISS" ? "dismissed" : "processed"} successfully.${detail}`,
      });

      setSelectedReport(null);
      setModerationNote("");
      setSuspensionDays(7);
      queryClient.invalidateQueries({
        queryKey: ["staff-moderation-reports"],
      });
      queryClient.invalidateQueries({ queryKey: ["staff-moderation-stats"] });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to process action",
        variant: "destructive",
      });
    },
  });

  const handleReportAction = (
    reportId: string,
    action: "DISMISS" | "WARN" | "SUSPEND" | "BAN",
  ) => reportActionMutation.mutate({ reportId, action });

  // Handle profile verification
  const profileVerificationMutation = useMutation({
    mutationFn: async ({
      verificationId,
      status,
    }: {
      verificationId: string;
      status: "APPROVED" | "REJECTED" | "NEEDS_INFO";
    }) => {
      const response = await fetch(
        `/api/staff/moderation/profiles/${verificationId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status,
            reviewNotes: moderationNote,
            // For rejection or needs_info, include the note as feedback
            ...(status === "REJECTED" || status === "NEEDS_INFO"
              ? {
                  rejectionReason: moderationNote,
                  feedbackDetails: moderationNote,
                }
              : {}),
          }),
        },
      );

      if (!response.ok) throw new Error("Failed to update verification");
    },
    onSuccess: (_data, { status }) => {
      const statusMessages = {
        APPROVED: "approved",
        REJECTED: "rejected",
        NEEDS_INFO: "marked as needing more information",
      };

      toast({
        title: "Profile Updated",
        description: `Profile has been ${statusMessages[status]}`,
      });

      setSelectedProfile(null);
      setModerationNote("");
      queryClient.invalidateQueries({
        queryKey: ["staff-moderation-profiles"],
      });
      queryClient.invalidateQueries({ queryKey: ["staff-moderation-stats"] });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update profile verification",
        variant: "destructive",
      });
    },
  });

  const handleProfileVerification = (
    verificationId: string,
    status: "APPROVED" | "REJECTED" | "NEEDS_INFO",
  ) => profileVerificationMutation.mutate({ verificationId, status });

  // Handle review deletion
  const deleteReviewMutation = useMutation({
    mutationFn: async (reviewId: string) => {
      const response = await fetch(
        `/api/staff/moderation/reviews/${reviewId}`,
        {
          method: "DELETE",
        },
      );

      if (!response.ok) throw new Error("Failed to delete review");
    },
    onSuccess: () => {
      toast({
        title: "Review Deleted",
        description: "The review has been removed",
      });

      queryClient.invalidateQueries({
        queryKey: ["staff-moderation-reviews"],
      });
      queryClient.invalidateQueries({ queryKey: ["staff-moderation-stats"] });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to delete review",
        variant: "destructive",
      });
    },
  });

  const handleDeleteReview = (reviewId: string) =>
    deleteReviewMutation.mutate(reviewId);

  // Filter reports by search
  const filteredReports = searchQuery
    ? reports.filter(
        (r) =>
          r.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
          r.reason.toLowerCase().includes(searchQuery.toLowerCase()) ||
          r.reporter.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
          r.reportedUser.name
            ?.toLowerCase()
            .includes(searchQuery.toLowerCase()),
      )
    : reports;

  return (
    <div className="space-y-6">
      {/* Header */}
      <DashboardHeader
        title="Content Moderation"
        subtitle="Review and moderate platform content"
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefreshAll}
            disabled={isRefreshing}
          >
            <RefreshCw
              className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
            />
          </Button>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <Flag className="h-5 w-5 text-foreground" />
            </div>
            <div>
              {loadingStats ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : (
                <p className="text-2xl font-bold">
                  {stats?.pendingReports ?? 0}
                </p>
              )}
              <p className="text-sm text-muted-foreground">Pending Reports</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <User className="h-5 w-5 text-foreground" />
            </div>
            <div>
              {loadingStats ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : (
                <p className="text-2xl font-bold">
                  {stats?.pendingProfiles ?? 0}
                </p>
              )}
              <p className="text-sm text-muted-foreground">Profiles to Verify</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <Star className="h-5 w-5 text-foreground" />
            </div>
            <div>
              {loadingStats ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : (
                <p className="text-2xl font-bold">
                  {stats?.pendingReviews ?? 0}
                </p>
              )}
              <p className="text-sm text-muted-foreground">Reviews to Check</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-muted">
              <CheckCircle2 className="h-5 w-5 text-foreground" />
            </div>
            <div>
              {loadingStats ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : (
                <p className="text-2xl font-bold">
                  {stats?.resolvedToday ?? 0}
                </p>
              )}
              <p className="text-sm text-muted-foreground">Resolved Today</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="reports" className="gap-2">
            <Flag className="h-4 w-4" />
            Reports
            <Badge variant="secondary" className="ml-1">
              {stats?.pendingReports ?? 0}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="profiles" className="gap-2">
            <User className="h-4 w-4" />
            Profile Verification
            <Badge variant="secondary" className="ml-1">
              {stats?.pendingProfiles ?? 0}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="reviews" className="gap-2">
            <Star className="h-4 w-4" />
            Reviews
            <Badge variant="secondary" className="ml-1">
              {reviews.length}
            </Badge>
          </TabsTrigger>
        </TabsList>

        {/* Reports Tab */}
        <TabsContent value="reports" className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search reports..."
                  className="pl-9"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </CardContent>
          </Card>

          {reportsError && !reportsData ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3 text-center">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                <span>Failed to load moderation reports.</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => refetchReports()}
              >
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
            </div>
          ) : loadingReports ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filteredReports.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No pending reports
            </p>
          ) : (
            <div className="space-y-3">
              {filteredReports.map((report) => (
                <Card
                  key={report.id}
                  className="cursor-pointer hover:shadow-md transition-shadow"
                  onClick={() => setSelectedReport(report)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <div className="p-2 rounded-lg bg-muted text-foreground">
                          {getTypeIcon(report.type)}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-medium">
                              {report.id.slice(0, 8)}...
                            </p>
                            <Badge variant="outline" className="capitalize">
                              {report.type}
                            </Badge>
                            <Badge
                              className={getStatusColor(report.status)}
                              variant="secondary"
                            >
                              {report.status}
                            </Badge>
                          </div>
                          <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                            {report.description || report.reason}
                          </p>
                          <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                            <span>
                              Reported by: {report.reporter.name || "Anonymous"}
                            </span>
                            <span>
                              Against:{" "}
                              {report.reportedUser.name ||
                                report.reportedUser.email}
                            </span>
                            <span>Reason: {report.reason}</span>
                          </div>
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground/70">
                        {formatDate(report.createdAt)}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Profiles Tab */}
        <TabsContent value="profiles" className="space-y-4">
          {profilesError && !profilesData ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3 text-center">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                <span>Failed to load profile verifications.</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => refetchProfiles()}
              >
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
            </div>
          ) : loadingProfiles ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : profiles.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No pending profile verifications
            </p>
          ) : (
            <div className="space-y-3">
              {profiles.map((profile) => (
                <Card
                  key={profile.id}
                  className="cursor-pointer hover:shadow-md transition-shadow"
                  onClick={() => setSelectedProfile(profile)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-4">
                        <Avatar className="h-12 w-12">
                          <AvatarImage src={profile.consultant.image || ""} />
                          <AvatarFallback>
                            {(profile.consultant.name || "?")
                              .split(" ")
                              .map((n: string) => n[0])
                              .join("")}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium">
                            {profile.consultant.name || "Unnamed"}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {profile.consultant.email}
                          </p>
                          <div className="flex items-center gap-2 mt-1">
                            {profile.consultant.headline && (
                              <span className="text-sm text-muted-foreground">
                                {profile.consultant.headline}
                              </span>
                            )}
                            {profile.consultant.experience && (
                              <span className="text-xs text-muted-foreground">
                                • {profile.consultant.experience} years
                                experience
                              </span>
                            )}
                          </div>
                          {profile.consultant.linkedinUrl && (
                            <a
                              href={profile.consultant.linkedinUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-foreground underline-offset-2 hover:underline flex items-center gap-1 mt-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <ExternalLink className="h-3 w-3" />
                              LinkedIn Profile
                            </a>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                          Pending Review
                        </Badge>
                        <p className="text-xs text-muted-foreground/70 mt-1">
                          {formatDate(profile.submittedAt)}
                        </p>
                        <p className="text-xs text-muted-foreground mt-1">
                          {profile.consultant.domain}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <FileText className="h-4 w-4 text-muted-foreground/70" />
                      <span className="text-sm text-muted-foreground">
                        {profile.documents.length} document
                        {profile.documents.length !== 1 ? "s" : ""} attached
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Reviews Tab */}
        <TabsContent value="reviews" className="space-y-4">
          {reviewsError && !reviewsData ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3 text-center">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                <span>Failed to load reviews.</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => refetchReviews()}
              >
                <RefreshCw className="h-4 w-4" />
                Retry
              </Button>
            </div>
          ) : loadingReviews ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : reviews.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No reviews to check
            </p>
          ) : (
            <div className="space-y-3">
              {reviews.map((review) => {
                const consulteeName = review.consultee?.name || "Anonymous";
                const consulteeImage = review.consultee?.image || "";
                const consultantName =
                  review.consultation?.consultant?.user?.name || "Consultant";

                return (
                  <Card key={review.id}>
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-3">
                          <Avatar>
                            <AvatarImage src={consulteeImage} />
                            <AvatarFallback>
                              {consulteeName
                                .split(" ")
                                .map((n) => n[0])
                                .join("")}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-medium">{consulteeName}</p>
                              <span className="text-muted-foreground/70">→</span>
                              <p className="text-muted-foreground">
                                {consultantName}
                              </p>
                            </div>
                            <div className="flex items-center gap-1 mt-1">
                              {Array.from({ length: 5 }).map((_, i) => (
                                <Star
                                  key={i}
                                  className={`h-4 w-4 ${
                                    i < review.rating
                                      ? "text-yellow-400 fill-yellow-400"
                                      : "text-muted-foreground/30"
                                  }`}
                                />
                              ))}
                            </div>
                            {review.comment && (
                              <p className="text-sm text-muted-foreground mt-2">
                                {review.comment}
                              </p>
                            )}
                          </div>
                        </div>
                        <span className="text-xs text-muted-foreground/70">
                          {formatDate(review.createdAt)}
                        </span>
                      </div>
                      <div className="flex justify-end gap-2 mt-4">
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1"
                          onClick={() => handleDeleteReview(review.id)}
                        >
                          <ThumbsDown className="h-4 w-4" />
                          Remove
                        </Button>
                        <Button size="sm" className="gap-1">
                          <ThumbsUp className="h-4 w-4" />
                          Approve
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Report Detail Dialog */}
      <ResponsiveModal
        open={!!selectedReport}
        onOpenChange={() => setSelectedReport(null)}
      >
        <ResponsiveModalContent className="max-w-2xl">
          {selectedReport && (
            <>
              <ResponsiveModalHeader>
                <ResponsiveModalTitle className="flex items-center gap-2">
                  <Flag className="h-5 w-5 text-red-500" />
                  Report {selectedReport.id.slice(0, 8)}...
                </ResponsiveModalTitle>
                <ResponsiveModalDescription>
                  Review and take action on this report
                </ResponsiveModalDescription>
              </ResponsiveModalHeader>
              <div className="space-y-4">
                <div className="p-4 rounded-lg bg-muted">
                  <Label className="text-sm font-medium">
                    Reported Content
                  </Label>
                  <p className="mt-1 text-sm">
                    {selectedReport.description || selectedReport.reason}
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label className="text-sm font-medium">Reported By</Label>
                    <p className="text-sm text-muted-foreground">
                      {selectedReport.reporter.name || "Anonymous"}
                    </p>
                    <p className="text-xs text-muted-foreground/70">
                      {selectedReport.reporter.email}
                    </p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">Target User</Label>
                    <p className="text-sm text-muted-foreground">
                      {selectedReport.reportedUser.name ||
                        selectedReport.reportedUser.email}
                    </p>
                    <p className="text-xs text-muted-foreground/70">
                      {selectedReport.reportedUser.role}
                    </p>
                  </div>
                </div>
                <div>
                  <Label className="text-sm font-medium">Reason</Label>
                  <p className="text-sm text-muted-foreground">
                    {selectedReport.reason}
                  </p>
                </div>
                <div>
                  <Label htmlFor="note">Moderation Note</Label>
                  <Textarea
                    id="note"
                    placeholder="Add a note about your decision..."
                    className="mt-1"
                    value={moderationNote}
                    onChange={(e) => setModerationNote(e.target.value)}
                  />
                </div>
                <div>
                  <Label className="text-sm font-medium">
                    Suspension duration (applies to Suspend only)
                  </Label>
                  <div className="mt-1 flex items-center gap-2">
                    {[7, 30, 90].map((days) => (
                      <Button
                        key={days}
                        type="button"
                        size="sm"
                        variant={
                          suspensionDays === days ? "default" : "outline"
                        }
                        onClick={() => setSuspensionDays(days)}
                        disabled={reportActionMutation.isPending}
                      >
                        {days} days
                      </Button>
                    ))}
                    <Input
                      type="number"
                      min={1}
                      max={365}
                      className="w-24"
                      value={Number.isFinite(suspensionDays) ? suspensionDays : ""}
                      onChange={(e) => {
                        // NaN sentinel lets the field be cleared while typing;
                        // the Suspend button disables until a valid number is back
                        if (e.target.value === "") {
                          setSuspensionDays(NaN);
                          return;
                        }
                        const v = parseInt(e.target.value, 10);
                        if (Number.isFinite(v))
                          setSuspensionDays(Math.min(365, Math.max(1, v)));
                      }}
                      disabled={reportActionMutation.isPending}
                      aria-label="Custom suspension days"
                    />
                  </div>
                </div>
              </div>
              <ResponsiveModalFooter className="gap-2">
                <Button
                  variant="outline"
                  onClick={() => setSelectedReport(null)}
                  disabled={reportActionMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  variant="outline"
                  className="text-green-600 dark:text-green-400"
                  onClick={() =>
                    handleReportAction(selectedReport.id, "DISMISS")
                  }
                  disabled={reportActionMutation.isPending}
                >
                  {reportActionMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                  )}
                  Dismiss
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleReportAction(selectedReport.id, "WARN")}
                  disabled={reportActionMutation.isPending}
                >
                  {reportActionMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <XCircle className="h-4 w-4 mr-2" />
                  )}
                  Warn
                </Button>
                <Button
                  variant="destructive"
                  onClick={() =>
                    handleReportAction(selectedReport.id, "SUSPEND")
                  }
                  disabled={
                    reportActionMutation.isPending ||
                    !Number.isFinite(suspensionDays)
                  }
                >
                  {reportActionMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <XCircle className="h-4 w-4 mr-2" />
                  )}
                  Suspend
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => handleReportAction(selectedReport.id, "BAN")}
                  disabled={reportActionMutation.isPending}
                >
                  {reportActionMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <XCircle className="h-4 w-4 mr-2" />
                  )}
                  Ban
                </Button>
              </ResponsiveModalFooter>
            </>
          )}
        </ResponsiveModalContent>
      </ResponsiveModal>

      {/* Profile Verification Dialog */}
      <ResponsiveModal
        open={!!selectedProfile}
        onOpenChange={() => setSelectedProfile(null)}
      >
        <ResponsiveModalContent className="max-w-2xl">
          {selectedProfile && (
            <>
              <ResponsiveModalHeader>
                <ResponsiveModalTitle>
                  Profile Verification
                </ResponsiveModalTitle>
                <ResponsiveModalDescription>
                  Review consultant profile and documents
                </ResponsiveModalDescription>
              </ResponsiveModalHeader>
              <div className="space-y-4">
                <div className="flex items-center gap-4 p-4 rounded-lg bg-muted">
                  <Avatar className="h-16 w-16">
                    <AvatarImage src={selectedProfile.consultant.image || ""} />
                    <AvatarFallback className="text-lg">
                      {(selectedProfile.consultant.name || "?")
                        .split(" ")
                        .map((n: string) => n[0])
                        .join("")}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <h3 className="text-lg font-semibold">
                      {selectedProfile.consultant.name || "Unnamed"}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {selectedProfile.consultant.email}
                    </p>
                    {selectedProfile.consultant.linkedinUrl && (
                      <a
                        href={selectedProfile.consultant.linkedinUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-foreground underline-offset-2 hover:underline flex items-center gap-1 mt-1"
                      >
                        <ExternalLink className="h-3 w-3" />
                        View LinkedIn Profile
                      </a>
                    )}
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label className="text-sm font-medium">Headline</Label>
                    <p className="text-sm text-muted-foreground">
                      {selectedProfile.consultant.headline || "Not specified"}
                    </p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">Experience</Label>
                    <p className="text-sm text-muted-foreground">
                      {selectedProfile.consultant.experience
                        ? `${selectedProfile.consultant.experience} years`
                        : "Not specified"}
                    </p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">Domain</Label>
                    <p className="text-sm text-muted-foreground">
                      {selectedProfile.consultant.domain}
                    </p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">
                      Current Status
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {selectedProfile.consultant.verificationStatus}
                    </p>
                  </div>
                </div>
                {selectedProfile.notes && (
                  <div>
                    <Label className="text-sm font-medium">
                      Applicant Notes
                    </Label>
                    <p className="text-sm text-muted-foreground bg-muted p-2 rounded">
                      {selectedProfile.notes}
                    </p>
                  </div>
                )}
                <div>
                  <Label className="text-sm font-medium">
                    Documents ({selectedProfile.documents.length})
                  </Label>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {selectedProfile.documents.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No documents uploaded
                      </p>
                    ) : (
                      selectedProfile.documents.map((doc) => (
                        <Button
                          key={doc.id}
                          variant="outline"
                          size="sm"
                          className="gap-1"
                          asChild
                        >
                          <a
                            href={doc.fileUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <FileText className="h-4 w-4" />
                            {doc.description || doc.originalName}
                            <Eye className="h-3 w-3 ml-1" />
                          </a>
                        </Button>
                      ))
                    )}
                  </div>
                </div>
                <div>
                  <Label htmlFor="verifyNote">
                    Verification Note{" "}
                    <span className="text-xs text-muted-foreground font-normal">
                      (required for Request Info or Reject)
                    </span>
                  </Label>
                  <Textarea
                    id="verifyNote"
                    placeholder="Add notes about the verification... (e.g., what documents or info is needed, reasons for rejection)"
                    className="mt-1"
                    value={moderationNote}
                    onChange={(e) => setModerationNote(e.target.value)}
                  />
                </div>
              </div>
              <ResponsiveModalFooter className="gap-2">
                <Button
                  variant="outline"
                  onClick={() => setSelectedProfile(null)}
                  disabled={profileVerificationMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  variant="outline"
                  className="text-red-600 dark:text-red-400"
                  onClick={() =>
                    handleProfileVerification(selectedProfile.id, "REJECTED")
                  }
                  disabled={profileVerificationMutation.isPending}
                >
                  {profileVerificationMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <XCircle className="h-4 w-4 mr-2" />
                  )}
                  Reject
                </Button>
                <Button
                  variant="outline"
                  className="text-amber-600 border-amber-300 hover:bg-amber-50 dark:text-amber-400 dark:border-amber-800 dark:hover:bg-amber-950"
                  onClick={() =>
                    handleProfileVerification(selectedProfile.id, "NEEDS_INFO")
                  }
                  disabled={
                    profileVerificationMutation.isPending ||
                    !moderationNote.trim()
                  }
                  title={
                    !moderationNote.trim()
                      ? "Add a note explaining what information is needed"
                      : ""
                  }
                >
                  {profileVerificationMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <MessageSquare className="h-4 w-4 mr-2" />
                  )}
                  Request Info
                </Button>
                <Button
                  className="bg-green-600 hover:bg-green-700"
                  onClick={() =>
                    handleProfileVerification(selectedProfile.id, "APPROVED")
                  }
                  disabled={profileVerificationMutation.isPending}
                >
                  {profileVerificationMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                  )}
                  Approve Profile
                </Button>
              </ResponsiveModalFooter>
            </>
          )}
        </ResponsiveModalContent>
      </ResponsiveModal>
    </div>
  );
}
