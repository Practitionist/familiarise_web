"use client";

import React, { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ChevronLeft, Loader2, Shield, Info } from "lucide-react";
import {
  VerificationDocumentUpload,
  type UploadedDocument,
} from "@/components/verification/VerificationDocumentUpload";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import TermsAndPrivacyAgreement from "./TermsAndPrivacyAgreement";
import type { OnboardingFormData } from "@/utils/onboarding";

interface ConsultantAgreementAndVerificationStepProps {
  onNext: (data: Partial<OnboardingFormData>) => void;
  onBack: () => void;
  formData: Partial<OnboardingFormData>;
}

export default function ConsultantAgreementAndVerificationStep({
  onNext,
  onBack,
  formData,
}: ConsultantAgreementAndVerificationStepProps) {
  // Agreement state
  const [termsChecked, setTermsChecked] = useState(
    formData.termsAccepted || false,
  );
  const [privacyChecked, setPrivacyChecked] = useState(
    formData.privacyAccepted || false,
  );

  // Verification state
  const [linkedinUrl, setLinkedinUrl] = useState(
    formData.verificationLinkedinUrl || "",
  );
  const [notes, setNotes] = useState(formData.verificationNotes || "");
  const [documents, setDocuments] = useState<UploadedDocument[]>(
    // Schema uses z.array(z.any()) for verification documents; cast to concrete type
    (formData.verificationDocuments as UploadedDocument[]) || [],
  );
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validateLinkedIn = (url: string) => {
    if (!url) return true;
    const linkedinRegex = /^https?:\/\/(www\.)?linkedin\.com\/in\/[\w-]+\/?$/i;
    return linkedinRegex.test(url);
  };

  const handleUpload = useCallback(
    async (file: File): Promise<UploadedDocument> => {
      setIsUploading(true);
      setError(null);

      try {
        const uploadFormData = new FormData();
        uploadFormData.append("file", file);
        uploadFormData.append("onboarding", "true");

        const response = await fetch("/api/verification/documents", {
          method: "POST",
          body: uploadFormData,
        });

        const result = await response.json();

        if (!result.success) {
          throw new Error(result.error || "Upload failed");
        }

        // API response boundary — would need a response schema to avoid this
        return result.data as UploadedDocument;
      } finally {
        setIsUploading(false);
      }
    },
    [],
  );

  const handleRemove = useCallback(async (documentId: string) => {
    try {
      await fetch(`/api/verification/documents?id=${documentId}`, {
        method: "DELETE",
      });
    } catch (error) {
      console.error("Failed to delete verification document:", error);
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate agreement
    if (!termsChecked || !privacyChecked) {
      setError("You must accept both terms and privacy policy to continue.");
      return;
    }

    // Validate LinkedIn URL if provided
    if (linkedinUrl && !validateLinkedIn(linkedinUrl)) {
      setError("Please enter a valid LinkedIn profile URL");
      return;
    }

    // LinkedIn URL is required
    if (!linkedinUrl) {
      setError("LinkedIn profile URL is required for verification");
      return;
    }

    // At least one document is required
    const completedDocuments = documents.filter((d) => d.status === "uploaded");
    if (completedDocuments.length === 0) {
      setError(
        "Please upload at least one supporting document (certification, degree, license, or ID)",
      );
      return;
    }

    // Merge all data and submit
    const finalData = {
      ...formData,
      termsAccepted: true,
      privacyAccepted: true,
      verificationLinkedinUrl: linkedinUrl,
      verificationNotes: notes,
      verificationDocuments: documents,
    };

    onNext(finalData);
  };

  const hasInProgressUploads = documents.some((d) => d.status === "uploading");

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {/* Verification Section */}
      <div className="space-y-6">
        <Alert className="border-blue-200 bg-blue-50">
          <Shield className="h-4 w-4 text-blue-600" />
          <AlertTitle className="text-blue-800">
            Profile Verification
          </AlertTitle>
          <AlertDescription className="text-blue-700">
            To maintain platform quality, we verify all consultant profiles.
            Your LinkedIn profile and at least one supporting document are
            required.
          </AlertDescription>
        </Alert>

        {/* LinkedIn URL */}
        <div className="space-y-2">
          <Label htmlFor="linkedinUrl" className="flex items-center gap-1">
            LinkedIn Profile URL <span className="text-red-500">*</span>
          </Label>
          <Input
            id="linkedinUrl"
            type="url"
            placeholder="https://linkedin.com/in/yourprofile"
            value={linkedinUrl}
            onChange={(e) => setLinkedinUrl(e.target.value)}
            className={
              linkedinUrl && !validateLinkedIn(linkedinUrl)
                ? "border-red-500"
                : ""
            }
          />
          <p className="text-xs text-zinc-500">
            We use your LinkedIn profile to verify your professional background.
          </p>
          {linkedinUrl && !validateLinkedIn(linkedinUrl) && (
            <p className="text-xs text-red-500">
              Please enter a valid LinkedIn URL (e.g.,
              https://linkedin.com/in/username)
            </p>
          )}
        </div>

        {/* Document Upload */}
        <div className="space-y-2">
          <Label className="flex items-center gap-1">
            Supporting Documents <span className="text-red-500">*</span>
          </Label>
          <div className="bg-zinc-50 p-1 rounded-lg border border-zinc-200 mb-2">
            <div className="flex items-start gap-2 p-2 text-xs text-zinc-600">
              <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <p>
                Upload at least one document that verifies your expertise:
                professional certifications, degrees, licenses, or government
                ID.
              </p>
            </div>
          </div>
          <VerificationDocumentUpload
            documents={documents}
            onDocumentsChange={setDocuments}
            onUpload={handleUpload}
            onRemove={handleRemove}
            maxFiles={5}
            disabled={isUploading}
          />
          <p className="text-xs text-muted-foreground">
            Accepted formats: PDF, PNG, JPG, JPEG (max 10MB per file)
          </p>
        </div>

        {/* Additional Notes */}
        <div className="space-y-2">
          <Label htmlFor="notes" className="flex items-center gap-1">
            Additional Notes{" "}
            <span className="text-zinc-400 text-xs font-normal">
              (Optional)
            </span>
          </Label>
          <Textarea
            id="notes"
            placeholder="Any additional information about your professional background..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            maxLength={500}
          />
          <p className="text-xs text-zinc-500 text-right">
            {notes.length}/500 characters
          </p>
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-zinc-200" />

      {/* Agreement Section */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Terms and Conditions
        </h3>
        <p className="text-sm text-muted-foreground">
          Please review and accept our terms to complete your profile setup
        </p>
        <TermsAndPrivacyAgreement
          onTermsChange={setTermsChecked}
          onPrivacyChange={setPrivacyChecked}
          termsChecked={termsChecked}
          privacyChecked={privacyChecked}
        />
        {(!termsChecked || !privacyChecked) && (
          <p className="text-sm text-muted-foreground">
            You must accept both agreements to continue.
          </p>
        )}
      </div>

      {/* Verification Timeline Info */}
      <div className="bg-zinc-50 rounded-lg p-4 border border-zinc-200">
        <h4 className="font-medium text-sm text-zinc-900 mb-2">
          What happens next?
        </h4>
        <ol className="text-sm text-zinc-600 space-y-1 list-decimal list-inside">
          <li>Our team will review your LinkedIn profile and documents</li>
          <li>
            You&apos;ll receive an email notification once the review is complete
          </li>
          <li>
            Once verified, your profile will be visible in the consultant
            directory
          </li>
        </ol>
        <p className="text-xs text-zinc-500 mt-2">
          Verification typically takes 1-2 business days.
        </p>
      </div>

      {/* Error Display */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Navigation Buttons */}
      <div className="flex justify-between pt-4 border-t border-zinc-200">
        <Button type="button" variant="outline" onClick={onBack}>
          <ChevronLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button
          type="submit"
          disabled={
            isUploading ||
            hasInProgressUploads ||
            !termsChecked ||
            !privacyChecked
          }
        >
          {isUploading || hasInProgressUploads ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Uploading...
            </>
          ) : (
            "Continue to Review"
          )}
        </Button>
      </div>
    </form>
  );
}
