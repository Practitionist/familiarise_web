"use client";

import { useState, useEffect, useCallback } from "react";
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
import { PageHeader } from "@/components/ui/page-header";
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

  // Data states
  const [reports, setReports] = useState<ModerationReport[]>([]);
  const [profiles, setProfiles] = useState<ProfileVerification[]>([]);
  const [reviews, setReviews] = useState<ModerationReview[]>([]);
  const [stats, setStats] = useState<ModerationStats | null>(null);

  // Loading states
  const [loadingReports, setLoadingReports] = useState(true);
  const [loadingProfiles, setLoadingProfiles] = useState(true);
  const [loadingReviews, setLoadingReviews] = useState(true);
  const [loadingStats, setLoadingStats] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const { toast } = useToast();

  // Fetch moderation stats
  const fetchStats = async () => {
    try {
      setLoadingStats(true);
      const response = await fetch("/api/staff/moderation/stats");
      if (!response.ok) throw new Error("Failed to fetch stats");
      const data = await response.json();
      setStats(data);
    } catch (error) {
      console.error("Error fetching stats:", error);
    } finally {
      setLoadingStats(false);
    }
  };

  // Fetch moderation reports
  const fetchReports = useCallback(async () => {
    try {
      setLoadingReports(true);
      const response = await fetch(
        "/api/staff/moderation/reports?status=PENDING",
      );
      if (!response.ok) throw new Error("Failed to fetch reports");
      const data = await response.json();
      setReports(data.reports || []);
    } catch (error) {
      console.error("Error fetching reports:", error);
      toast({
        title: "Error",
        description: "Failed to load moderation reports",
        variant: "destructive",
      });
    } finally {
      setLoadingReports(false);
    }
  }, [toast]);

  // Fetch profile verifications
  const fetchProfiles = useCallback(async () => {
    try {
      setLoadingProfiles(true);
      const response = await fetch(
        "/api/staff/moderation/profiles?status=PENDING",
      );
      if (!response.ok) throw new Error("Failed to fetch profiles");
      const data = await response.json();
      setProfiles(data.verifications || []);
    } catch (error) {
      console.error("Error fetching profiles:", error);
      toast({
        title: "Error",
        description: "Failed to load profile verifications",
        variant: "destructive",
      });
    } finally {
      setLoadingProfiles(false);
    }
  }, [toast]);

  // Fetch reviews
  const fetchReviews = useCallback(async () => {
    try {
      setLoadingReviews(true);
      const response = await fetch("/api/staff/moderation/reviews?limit=10");
      if (!response.ok) throw new Error("Failed to fetch reviews");
      const data = await response.json();
      setReviews(data.reviews || []);
    } catch (error) {
      console.error("Error fetching reviews:", error);
      toast({
        title: "Error",
        description: "Failed to load reviews",
        variant: "destructive",
      });
    } finally {
      setLoadingReviews(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchStats();
    fetchReports();
    fetchProfiles();
    fetchReviews();
  }, [fetchReports, fetchProfiles, fetchReviews]);

  // Handle report action (dismiss or take action)
  const handleReportAction = async (
    reportId: string,
    action: "DISMISS" | "WARN" | "SUSPEND" | "BAN",
  ) => {
    try {
      setSubmitting(true);
      const response = await fetch(
        `/api/staff/moderation/reports/${reportId}/action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actionType: action,
            reason: moderationNote,
          }),
        },
      );

      if (!response.ok) throw new Error("Failed to process action");

      toast({
        title: "Action Completed",
        description: `Report has been ${action === "DISMISS" ? "dismissed" : "processed"} successfully`,
      });

      setSelectedReport(null);
      setModerationNote("");
      fetchReports();
      fetchStats();
    } catch (_error) {
      toast({
        title: "Error",
        description: "Failed to process action",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  // Handle profile verification
  const handleProfileVerification = async (
    verificationId: string,
    status: "APPROVED" | "REJECTED" | "NEEDS_INFO",
  ) => {
    try {
      setSubmitting(true);
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
      fetchProfiles();
      fetchStats();
    } catch (_error) {
      toast({
        title: "Error",
        description: "Failed to update profile verification",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  // Handle review deletion
  const handleDeleteReview = async (reviewId: string) => {
    try {
      const response = await fetch(
        `/api/staff/moderation/reviews/${reviewId}`,
        {
          method: "DELETE",
        },
      );

      if (!response.ok) throw new Error("Failed to delete review");

      toast({
        title: "Review Deleted",
        description: "The review has been removed",
      });

      fetchReviews();
      fetchStats();
    } catch (_error) {
      toast({
        title: "Error",
        description: "Failed to delete review",
        variant: "destructive",
      });
    }
  };

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
      <PageHeader
        title="Content Moderation"
        description="Review and moderate platform content"
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              fetchStats();
              fetchReports();
              fetchProfiles();
              fetchReviews();
            }}
            disabled={loadingStats}
          >
            <RefreshCw
              className={`h-4 w-4 ${loadingStats ? "animate-spin" : ""}`}
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

          {loadingReports ? (
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
          {loadingProfiles ? (
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
          {loadingReviews ? (
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
              </div>
              <ResponsiveModalFooter className="gap-2">
                <Button
                  variant="outline"
                  onClick={() => setSelectedReport(null)}
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button
                  variant="outline"
                  className="text-green-600 dark:text-green-400"
                  onClick={() =>
                    handleReportAction(selectedReport.id, "DISMISS")
                  }
                  disabled={submitting}
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                  )}
                  Dismiss Report
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => handleReportAction(selectedReport.id, "WARN")}
                  disabled={submitting}
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <XCircle className="h-4 w-4 mr-2" />
                  )}
                  Take Action
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
                  disabled={submitting}
                >
                  Cancel
                </Button>
                <Button
                  variant="outline"
                  className="text-red-600 dark:text-red-400"
                  onClick={() =>
                    handleProfileVerification(selectedProfile.id, "REJECTED")
                  }
                  disabled={submitting}
                >
                  {submitting ? (
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
                  disabled={submitting || !moderationNote.trim()}
                  title={
                    !moderationNote.trim()
                      ? "Add a note explaining what information is needed"
                      : ""
                  }
                >
                  {submitting ? (
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
                  disabled={submitting}
                >
                  {submitting ? (
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
