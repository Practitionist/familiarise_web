"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Search,
  Flag,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Star,
  MessageSquare,
  User,
  FileText,
  Eye,
  ThumbsUp,
  ThumbsDown,
} from "lucide-react";

// Mock data for reported content
const reportedContent = [
  {
    id: "RPT-001",
    type: "review",
    content: "This consultant is a complete fraud! Do not trust them!",
    reportedBy: { name: "User123", email: "user123@example.com" },
    targetUser: { name: "Dr. Jane Smith", role: "CONSULTANT" },
    reason: "Inappropriate content",
    status: "pending",
    createdAt: "2025-12-20T10:30:00",
    reportCount: 3,
  },
  {
    id: "RPT-002",
    type: "profile",
    content: "Profile contains misleading credentials and fake certifications",
    reportedBy: { name: "User456", email: "user456@example.com" },
    targetUser: { name: "Mike Wilson", role: "CONSULTANT" },
    reason: "Fake credentials",
    status: "pending",
    createdAt: "2025-12-19T14:00:00",
    reportCount: 5,
  },
  {
    id: "RPT-003",
    type: "message",
    content: "User sent unsolicited promotional messages",
    reportedBy: { name: "User789", email: "user789@example.com" },
    targetUser: { name: "Alex Brown", role: "CONSULTEE" },
    reason: "Spam",
    status: "resolved",
    createdAt: "2025-12-18T09:00:00",
    reportCount: 1,
  },
];

const pendingProfiles = [
  {
    id: "PRF-001",
    name: "Dr. Rajesh Kumar",
    email: "rajesh@example.com",
    specialization: "Business Consulting",
    qualifications: "MBA, Harvard Business School",
    experience: "15 years",
    submittedAt: "2025-12-19T16:00:00",
    documents: ["degree.pdf", "certificate.pdf"],
  },
  {
    id: "PRF-002",
    name: "Priya Sharma",
    email: "priya@example.com",
    specialization: "Career Counseling",
    qualifications: "M.A. Psychology",
    experience: "8 years",
    submittedAt: "2025-12-20T08:00:00",
    documents: ["degree.pdf"],
  },
];

const pendingReviews = [
  {
    id: "REV-001",
    reviewer: { name: "John Doe", avatar: "" },
    consultant: { name: "Dr. Jane Smith", avatar: "" },
    rating: 4,
    content: "Great session! Very helpful and insightful. Would definitely recommend to others looking for career guidance.",
    submittedAt: "2025-12-20T11:00:00",
  },
  {
    id: "REV-002",
    reviewer: { name: "Sarah Connor", avatar: "" },
    consultant: { name: "Mike Wilson", avatar: "" },
    rating: 2,
    content: "Session was okay but the consultant seemed unprepared and distracted during our call.",
    submittedAt: "2025-12-20T09:30:00",
  },
];

const getStatusColor = (status: string) => {
  switch (status) {
    case "pending":
      return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
    case "resolved":
      return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
    case "rejected":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
};

const getTypeIcon = (type: string) => {
  switch (type) {
    case "review":
      return <Star className="h-4 w-4" />;
    case "profile":
      return <User className="h-4 w-4" />;
    case "message":
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
  const [selectedReport, setSelectedReport] = useState<typeof reportedContent[0] | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<typeof pendingProfiles[0] | null>(null);
  const [moderationNote, setModerationNote] = useState("");

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Content Moderation
          </h1>
          <p className="text-zinc-500 dark:text-zinc-400">
            Review and moderate platform content
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-red-50 dark:bg-red-950">
              <Flag className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{reportedContent.filter(r => r.status === "pending").length}</p>
              <p className="text-sm text-zinc-500">Pending Reports</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950">
              <User className="h-5 w-5 text-amber-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{pendingProfiles.length}</p>
              <p className="text-sm text-zinc-500">Profiles to Verify</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950">
              <Star className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{pendingReviews.length}</p>
              <p className="text-sm text-zinc-500">Reviews to Check</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-green-50 dark:bg-green-950">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">24</p>
              <p className="text-sm text-zinc-500">Resolved Today</p>
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
              {reportedContent.filter(r => r.status === "pending").length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="profiles" className="gap-2">
            <User className="h-4 w-4" />
            Profile Verification
            <Badge variant="secondary" className="ml-1">
              {pendingProfiles.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="reviews" className="gap-2">
            <Star className="h-4 w-4" />
            Reviews
            <Badge variant="secondary" className="ml-1">
              {pendingReviews.length}
            </Badge>
          </TabsTrigger>
        </TabsList>

        {/* Reports Tab */}
        <TabsContent value="reports" className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                <Input
                  placeholder="Search reports..."
                  className="pl-9"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </CardContent>
          </Card>

          <div className="space-y-3">
            {reportedContent.map((report) => (
              <Card key={report.id} className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setSelectedReport(report)}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <div className="p-2 rounded-lg bg-red-50 dark:bg-red-950">
                        {getTypeIcon(report.type)}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium">{report.id}</p>
                          <Badge variant="outline" className="capitalize">
                            {report.type}
                          </Badge>
                          <Badge className={getStatusColor(report.status)} variant="secondary">
                            {report.status}
                          </Badge>
                        </div>
                        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1 line-clamp-2">
                          {report.content}
                        </p>
                        <div className="flex items-center gap-4 mt-2 text-xs text-zinc-500">
                          <span>Reported by: {report.reportedBy.name}</span>
                          <span>Against: {report.targetUser.name}</span>
                          <span>Reason: {report.reason}</span>
                          <span>{report.reportCount} reports</span>
                        </div>
                      </div>
                    </div>
                    <span className="text-xs text-zinc-400">
                      {formatDate(report.createdAt)}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* Profiles Tab */}
        <TabsContent value="profiles" className="space-y-4">
          <div className="space-y-3">
            {pendingProfiles.map((profile) => (
              <Card key={profile.id} className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setSelectedProfile(profile)}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-4">
                      <Avatar className="h-12 w-12">
                        <AvatarFallback>
                          {profile.name.split(" ").map((n) => n[0]).join("")}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <p className="font-medium">{profile.name}</p>
                        <p className="text-sm text-zinc-500">{profile.email}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="outline">{profile.specialization}</Badge>
                          <span className="text-xs text-zinc-500">{profile.experience} experience</span>
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <Badge className="bg-amber-100 text-amber-700">Pending Review</Badge>
                      <p className="text-xs text-zinc-400 mt-1">
                        {formatDate(profile.submittedAt)}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <FileText className="h-4 w-4 text-zinc-400" />
                    <span className="text-sm text-zinc-500">
                      {profile.documents.length} documents attached
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* Reviews Tab */}
        <TabsContent value="reviews" className="space-y-4">
          <div className="space-y-3">
            {pendingReviews.map((review) => (
              <Card key={review.id}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <Avatar>
                        <AvatarImage src={review.reviewer.avatar} />
                        <AvatarFallback>
                          {review.reviewer.name.split(" ").map((n) => n[0]).join("")}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium">{review.reviewer.name}</p>
                          <span className="text-zinc-400">→</span>
                          <p className="text-zinc-600 dark:text-zinc-400">{review.consultant.name}</p>
                        </div>
                        <div className="flex items-center gap-1 mt-1">
                          {Array.from({ length: 5 }).map((_, i) => (
                            <Star
                              key={i}
                              className={`h-4 w-4 ${
                                i < review.rating
                                  ? "text-yellow-400 fill-yellow-400"
                                  : "text-zinc-300"
                              }`}
                            />
                          ))}
                        </div>
                        <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-2">
                          {review.content}
                        </p>
                      </div>
                    </div>
                    <span className="text-xs text-zinc-400">
                      {formatDate(review.submittedAt)}
                    </span>
                  </div>
                  <div className="flex justify-end gap-2 mt-4">
                    <Button variant="outline" size="sm" className="gap-1">
                      <ThumbsDown className="h-4 w-4" />
                      Reject
                    </Button>
                    <Button size="sm" className="gap-1">
                      <ThumbsUp className="h-4 w-4" />
                      Approve
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      {/* Report Detail Dialog */}
      <Dialog open={!!selectedReport} onOpenChange={() => setSelectedReport(null)}>
        <DialogContent className="max-w-2xl">
          {selectedReport && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Flag className="h-5 w-5 text-red-500" />
                  Report {selectedReport.id}
                </DialogTitle>
                <DialogDescription>
                  Review and take action on this report
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="p-4 rounded-lg bg-zinc-50 dark:bg-zinc-900">
                  <Label className="text-sm font-medium">Reported Content</Label>
                  <p className="mt-1 text-sm">{selectedReport.content}</p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label className="text-sm font-medium">Reported By</Label>
                    <p className="text-sm text-zinc-600">{selectedReport.reportedBy.name}</p>
                    <p className="text-xs text-zinc-400">{selectedReport.reportedBy.email}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">Target User</Label>
                    <p className="text-sm text-zinc-600">{selectedReport.targetUser.name}</p>
                    <p className="text-xs text-zinc-400">{selectedReport.targetUser.role}</p>
                  </div>
                </div>
                <div>
                  <Label className="text-sm font-medium">Reason</Label>
                  <p className="text-sm text-zinc-600">{selectedReport.reason}</p>
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
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setSelectedReport(null)}>
                  Cancel
                </Button>
                <Button variant="outline" className="text-green-600">
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Dismiss Report
                </Button>
                <Button variant="destructive">
                  <XCircle className="h-4 w-4 mr-2" />
                  Take Action
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Profile Verification Dialog */}
      <Dialog open={!!selectedProfile} onOpenChange={() => setSelectedProfile(null)}>
        <DialogContent className="max-w-2xl">
          {selectedProfile && (
            <>
              <DialogHeader>
                <DialogTitle>Profile Verification</DialogTitle>
                <DialogDescription>
                  Review consultant profile and documents
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="flex items-center gap-4 p-4 rounded-lg bg-zinc-50 dark:bg-zinc-900">
                  <Avatar className="h-16 w-16">
                    <AvatarFallback className="text-lg">
                      {selectedProfile.name.split(" ").map((n) => n[0]).join("")}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <h3 className="text-lg font-semibold">{selectedProfile.name}</h3>
                    <p className="text-sm text-zinc-500">{selectedProfile.email}</p>
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label className="text-sm font-medium">Specialization</Label>
                    <p className="text-sm text-zinc-600">{selectedProfile.specialization}</p>
                  </div>
                  <div>
                    <Label className="text-sm font-medium">Experience</Label>
                    <p className="text-sm text-zinc-600">{selectedProfile.experience}</p>
                  </div>
                </div>
                <div>
                  <Label className="text-sm font-medium">Qualifications</Label>
                  <p className="text-sm text-zinc-600">{selectedProfile.qualifications}</p>
                </div>
                <div>
                  <Label className="text-sm font-medium">Documents</Label>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {selectedProfile.documents.map((doc, i) => (
                      <Button key={i} variant="outline" size="sm" className="gap-1">
                        <FileText className="h-4 w-4" />
                        {doc}
                        <Eye className="h-3 w-3 ml-1" />
                      </Button>
                    ))}
                  </div>
                </div>
                <div>
                  <Label htmlFor="verifyNote">Verification Note</Label>
                  <Textarea
                    id="verifyNote"
                    placeholder="Add notes about the verification..."
                    className="mt-1"
                  />
                </div>
              </div>
              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setSelectedProfile(null)}>
                  Cancel
                </Button>
                <Button variant="outline" className="text-red-600">
                  <XCircle className="h-4 w-4 mr-2" />
                  Reject
                </Button>
                <Button className="bg-green-600 hover:bg-green-700">
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Approve Profile
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

