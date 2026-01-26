"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FileText,
  RefreshCw,
  User,
  Clock,
  CheckCircle2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { VerificationReviewModal } from "./VerificationReviewModal";

interface Document {
  id: string;
  documentType: string;
  documentUrl: string;
  status: string;
  isValid?: boolean | null;
  staffFeedback?: string | null;
}

interface ProfileVerification {
  id: string;
  status: string;
  notes: string | null;
  rejectionReason?: string | null;
  feedbackDetails?: string | null;
  submittedAt: string;
  consultantProfile: {
    id: string;
    description: string | null;
    headline: string | null;
    experience: number | null;
    user: {
      id: string;
      name: string | null;
      email: string;
      image?: string | null;
      linkedinUrl?: string | null;
      bio?: string | null;
    };
    domain?: { id: string; name: string } | null;
    subDomains?: { id: string; name: string }[];
    workExperiences?: {
      id: string;
      company: string;
      title: string;
      startDate: string;
      endDate?: string | null;
      current: boolean;
    }[];
    education?: {
      id: string;
      institution: string;
      degree: string;
      field: string;
      startYear: number;
      endYear?: number | null;
    }[];
    certifications?: {
      id: string;
      name: string;
      issuer: string;
      issueDate: string;
    }[];
  };
  documents: Document[];
}

interface VerificationQueueProps {
  apiBasePath?: string;
}

const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  return date.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

const formatRelativeTime = (dateString: string) => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMins = Math.floor(diffMs / (1000 * 60));

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(dateString);
};

export function VerificationQueue({
  apiBasePath = "/api/staff/moderation/profiles",
}: VerificationQueueProps) {
  const [verifications, setVerifications] = useState<ProfileVerification[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedVerification, setSelectedVerification] =
    useState<ProfileVerification | null>(null);
  const { toast } = useToast();

  const fetchVerifications = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch(`${apiBasePath}?status=PENDING`);
      if (!response.ok) throw new Error("Failed to fetch verifications");
      const data: { verifications?: ProfileVerification[] } = await response.json();
      setVerifications(data.verifications || []);
    } catch (error) {
      console.error("Error fetching verifications:", error);
      toast({
        title: "Error",
        description: "Failed to load pending verifications",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [apiBasePath, toast]);

  useEffect(() => {
    fetchVerifications();
  }, [fetchVerifications]);

  const handleVerificationComplete = () => {
    fetchVerifications();
    setSelectedVerification(null);
  };

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <Card key={i}>
            <CardContent className="p-4">
              <div className="flex items-center gap-4">
                <Skeleton className="h-12 w-12 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                </div>
                <Skeleton className="h-8 w-24" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (verifications.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <CheckCircle2 className="h-12 w-12 text-green-500 mb-4" />
          <h3 className="font-semibold text-lg">All Caught Up!</h3>
          <p className="text-zinc-500 text-sm mt-1">
            No pending verifications to review
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchVerifications}
            className="mt-4"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-zinc-500">
            {verifications.length} pending verification
            {verifications.length !== 1 ? "s" : ""}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchVerifications}
            disabled={loading}
          >
            <RefreshCw
              className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>

        {verifications.map((verification) => {
          const profile = verification.consultantProfile;
          // Skip verifications with missing profile or user data
          if (!profile || !profile.user) {
            console.warn("Skipping verification with missing profile data:", verification.id);
            return null;
          }
          const user = profile.user;

          // Use subDomains for specialization display
          const subDomainNames = profile.subDomains?.map((s: { name: string }) => s.name) || [];

          return (
            <Card
              key={verification.id}
              className="cursor-pointer hover:shadow-md transition-shadow hover:border-zinc-300 dark:hover:border-zinc-700"
              onClick={() => setSelectedVerification(verification)}
            >
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-4">
                    <Avatar className="h-12 w-12">
                      <AvatarImage src={user.image || ""} />
                      <AvatarFallback>
                        {(user.name || "?")
                          .split(" ")
                          .map((n: string) => n[0])
                          .join("")
                          .toUpperCase()
                          .slice(0, 2)}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">
                        {user.name || "Unnamed"}
                      </p>
                      <p className="text-sm text-zinc-500">{user.email}</p>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {profile.domain && (
                          <Badge variant="outline" className="text-xs">
                            {profile.domain.name}
                          </Badge>
                        )}
                        {subDomainNames.slice(0, 2).map((s: string, idx: number) => (
                          <Badge
                            key={idx}
                            variant="secondary"
                            className="text-xs"
                          >
                            {s}
                          </Badge>
                        ))}
                        {subDomainNames.length > 2 && (
                          <span className="text-xs text-zinc-400">
                            +{subDomainNames.length - 2} more
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                      Pending Review
                    </Badge>
                    <div className="flex items-center gap-1 text-xs text-zinc-400 mt-2 justify-end">
                      <Clock className="h-3 w-3" />
                      {formatRelativeTime(verification.submittedAt)}
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex items-center gap-4 text-sm text-zinc-500">
                  <div className="flex items-center gap-1">
                    <User className="h-4 w-4" />
                    {profile.experience
                      ? `${profile.experience} yrs exp`
                      : "No exp listed"}
                  </div>
                  <div className="flex items-center gap-1">
                    <FileText className="h-4 w-4" />
                    {verification.documents.length} document
                    {verification.documents.length !== 1 ? "s" : ""}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <VerificationReviewModal
        verification={selectedVerification}
        open={!!selectedVerification}
        onOpenChange={(open) => !open && setSelectedVerification(null)}
        onVerificationComplete={handleVerificationComplete}
        apiBasePath={apiBasePath}
      />
    </>
  );
}

export default VerificationQueue;
