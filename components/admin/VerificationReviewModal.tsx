"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  FileText,
  Eye,
  ExternalLink,
  ChevronDown,
  Loader2,
  User,
  Briefcase,
  GraduationCap,
  Award,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

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
    displayName: string | null;
    bio: string | null;
    specialization: string[];
    yearsOfExperience: number | null;
    hourlyRate?: number | null;
    user: {
      id: string;
      name: string | null;
      email: string;
      image?: string | null;
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

interface DocumentFeedback {
  documentId: string;
  isValid: boolean;
  staffFeedback: string;
}

interface VerificationReviewModalProps {
  verification: ProfileVerification | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onVerificationComplete: () => void;
  apiBasePath?: string; // Allow customization for admin vs staff
}

export function VerificationReviewModal({
  verification,
  open,
  onOpenChange,
  onVerificationComplete,
  apiBasePath = "/api/staff/moderation/profiles",
}: VerificationReviewModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [feedbackDetails, setFeedbackDetails] = useState("");
  const [documentFeedback, setDocumentFeedback] = useState<
    Record<string, DocumentFeedback>
  >({});
  const [showDetailedFeedback, setShowDetailedFeedback] = useState(false);
  const { toast } = useToast();

  const resetForm = () => {
    setRejectionReason("");
    setFeedbackDetails("");
    setDocumentFeedback({});
    setShowDetailedFeedback(false);
  };

  const handleDocumentValidityChange = (docId: string, isValid: boolean) => {
    setDocumentFeedback((prev) => ({
      ...prev,
      [docId]: {
        ...prev[docId],
        documentId: docId,
        isValid,
        staffFeedback: prev[docId]?.staffFeedback || "",
      },
    }));
  };

  const handleDocumentFeedbackChange = (docId: string, feedback: string) => {
    setDocumentFeedback((prev) => ({
      ...prev,
      [docId]: {
        ...prev[docId],
        documentId: docId,
        isValid: prev[docId]?.isValid ?? true,
        staffFeedback: feedback,
      },
    }));
  };

  const handleVerification = async (
    status: "APPROVED" | "REJECTED" | "NEEDS_INFO"
  ) => {
    if (!verification) return;

    // Validate required fields for rejection
    if ((status === "REJECTED" || status === "NEEDS_INFO") && !rejectionReason.trim()) {
      toast({
        title: "Reason Required",
        description: "Please provide a brief reason for rejection or requesting changes.",
        variant: "destructive",
      });
      return;
    }

    try {
      setSubmitting(true);

      const payload: Record<string, unknown> = {
        status,
      };

      if (status === "REJECTED" || status === "NEEDS_INFO") {
        payload.rejectionReason = rejectionReason.trim();
        if (feedbackDetails.trim()) {
          payload.feedbackDetails = feedbackDetails.trim();
        }
      }

      // Include document feedback if any
      const docFeedbackArray = Object.values(documentFeedback).filter(
        (df) => df.documentId
      );
      if (docFeedbackArray.length > 0) {
        payload.documentFeedback = docFeedbackArray;
      }

      const response = await fetch(`${apiBasePath}/${verification.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to update verification");
      }

      const statusMessages = {
        APPROVED: "Profile has been approved and verified",
        REJECTED: "Profile has been rejected",
        NEEDS_INFO: "Additional information has been requested",
      };

      toast({
        title: "Verification Updated",
        description: statusMessages[status],
      });

      resetForm();
      onOpenChange(false);
      onVerificationComplete();
    } catch (error) {
      toast({
        title: "Error",
        description:
          error instanceof Error
            ? error.message
            : "Failed to update verification",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (!verification) return null;

  const profile = verification.consultantProfile;
  const user = profile.user;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Profile Verification Review
          </DialogTitle>
          <DialogDescription>
            Review consultant profile, documents, and provide feedback
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Profile Header */}
          <div className="flex items-center gap-4 p-4 rounded-lg bg-zinc-50 dark:bg-zinc-900">
            <Avatar className="h-16 w-16">
              <AvatarImage src={user.image || ""} />
              <AvatarFallback className="text-lg">
                {(profile.displayName || user.name || "?")
                  .split(" ")
                  .map((n) => n[0])
                  .join("")
                  .toUpperCase()
                  .slice(0, 2)}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1">
              <h3 className="text-lg font-semibold">
                {profile.displayName || user.name || "Unnamed"}
              </h3>
              <p className="text-sm text-zinc-500">{user.email}</p>
              <div className="flex items-center gap-2 mt-1">
                {profile.domain && (
                  <Badge variant="secondary">{profile.domain.name}</Badge>
                )}
                {profile.yearsOfExperience && (
                  <span className="text-xs text-zinc-500">
                    {profile.yearsOfExperience} years exp.
                  </span>
                )}
                {profile.hourlyRate && (
                  <span className="text-xs text-zinc-500">
                    ${profile.hourlyRate}/hr
                  </span>
                )}
              </div>
            </div>
            <Badge
              className={
                verification.status === "PENDING"
                  ? "bg-amber-100 text-amber-700"
                  : verification.status === "APPROVED"
                    ? "bg-green-100 text-green-700"
                    : "bg-red-100 text-red-700"
              }
            >
              {verification.status}
            </Badge>
          </div>

          {/* Bio */}
          {profile.bio && (
            <div>
              <Label className="text-sm font-medium">Bio</Label>
              <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
                {profile.bio}
              </p>
            </div>
          )}

          {/* Specializations */}
          {profile.specialization && profile.specialization.length > 0 && (
            <div>
              <Label className="text-sm font-medium">Specializations</Label>
              <div className="flex flex-wrap gap-2 mt-1">
                {profile.specialization.map((spec, idx) => (
                  <Badge key={idx} variant="outline">
                    {spec}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Work Experience */}
          {profile.workExperiences && profile.workExperiences.length > 0 && (
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium w-full">
                <Briefcase className="h-4 w-4" />
                Work Experience ({profile.workExperiences.length})
                <ChevronDown className="h-4 w-4 ml-auto" />
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-2">
                {profile.workExperiences.map((exp) => (
                  <Card key={exp.id}>
                    <CardContent className="p-3">
                      <p className="font-medium">{exp.title}</p>
                      <p className="text-sm text-zinc-500">{exp.company}</p>
                      <p className="text-xs text-zinc-400">
                        {new Date(exp.startDate).getFullYear()} -{" "}
                        {exp.current
                          ? "Present"
                          : exp.endDate
                            ? new Date(exp.endDate).getFullYear()
                            : ""}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* Education */}
          {profile.education && profile.education.length > 0 && (
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium w-full">
                <GraduationCap className="h-4 w-4" />
                Education ({profile.education.length})
                <ChevronDown className="h-4 w-4 ml-auto" />
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-2">
                {profile.education.map((edu) => (
                  <Card key={edu.id}>
                    <CardContent className="p-3">
                      <p className="font-medium">
                        {edu.degree} in {edu.field}
                      </p>
                      <p className="text-sm text-zinc-500">{edu.institution}</p>
                      <p className="text-xs text-zinc-400">
                        {edu.startYear} - {edu.endYear || "Present"}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* Certifications */}
          {profile.certifications && profile.certifications.length > 0 && (
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium w-full">
                <Award className="h-4 w-4" />
                Certifications ({profile.certifications.length})
                <ChevronDown className="h-4 w-4 ml-auto" />
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2 space-y-2">
                {profile.certifications.map((cert) => (
                  <Card key={cert.id}>
                    <CardContent className="p-3">
                      <p className="font-medium">{cert.name}</p>
                      <p className="text-sm text-zinc-500">{cert.issuer}</p>
                      <p className="text-xs text-zinc-400">
                        Issued: {new Date(cert.issueDate).toLocaleDateString()}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}

          <Separator />

          {/* Documents with per-document feedback */}
          <div>
            <Label className="text-sm font-medium flex items-center gap-2">
              <FileText className="h-4 w-4" />
              Verification Documents ({verification.documents.length})
            </Label>
            <div className="space-y-3 mt-2">
              {verification.documents.map((doc) => (
                <Card key={doc.id}>
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-sm">{doc.documentType}</p>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2"
                            asChild
                          >
                            <a
                              href={doc.documentUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <Eye className="h-3 w-3 mr-1" />
                              View
                              <ExternalLink className="h-3 w-3 ml-1" />
                            </a>
                          </Button>
                        </div>
                        <div className="mt-2">
                          <Input
                            placeholder="Add feedback for this document..."
                            value={documentFeedback[doc.id]?.staffFeedback || ""}
                            onChange={(e) =>
                              handleDocumentFeedbackChange(doc.id, e.target.value)
                            }
                            className="text-sm h-8"
                          />
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Label
                          htmlFor={`valid-${doc.id}`}
                          className="text-xs text-zinc-500"
                        >
                          Valid
                        </Label>
                        <Switch
                          id={`valid-${doc.id}`}
                          checked={documentFeedback[doc.id]?.isValid ?? true}
                          onCheckedChange={(checked) =>
                            handleDocumentValidityChange(doc.id, checked)
                          }
                        />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          <Separator />

          {/* Feedback Section */}
          <div className="space-y-4">
            <div>
              <Label htmlFor="rejectionReason" className="flex items-center gap-1">
                Brief Reason
                <span className="text-xs text-zinc-400">
                  (Required for reject/request changes)
                </span>
              </Label>
              <Input
                id="rejectionReason"
                placeholder="e.g., Certificate appears expired, Missing ID verification"
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                className="mt-1"
              />
            </div>

            <Collapsible
              open={showDetailedFeedback}
              onOpenChange={setShowDetailedFeedback}
            >
              <CollapsibleTrigger className="flex items-center gap-2 text-sm text-zinc-500 hover:text-zinc-700">
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${showDetailedFeedback ? "rotate-180" : ""}`}
                />
                Add detailed feedback (optional)
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2">
                <Textarea
                  placeholder="Provide detailed feedback explaining what needs to be fixed or why the profile is being rejected..."
                  value={feedbackDetails}
                  onChange={(e) => setFeedbackDetails(e.target.value)}
                  rows={4}
                />
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => {
              resetForm();
              onOpenChange(false);
            }}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            className="text-amber-600 border-amber-200 hover:bg-amber-50"
            onClick={() => handleVerification("NEEDS_INFO")}
            disabled={submitting}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <AlertCircle className="h-4 w-4 mr-2" />
            )}
            Request Changes
          </Button>
          <Button
            variant="outline"
            className="text-red-600 border-red-200 hover:bg-red-50"
            onClick={() => handleVerification("REJECTED")}
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
            className="bg-green-600 hover:bg-green-700"
            onClick={() => handleVerification("APPROVED")}
            disabled={submitting}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4 mr-2" />
            )}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default VerificationReviewModal;
