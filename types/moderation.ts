/**
 * Shared types for Staff Moderation API responses.
 * Used by both the API route and the frontend page.
 */

export interface VerificationWorkExperience {
  id: string;
  company: string;
  title: string;
  startDate: string;
  endDate: string | null;
  current: boolean;
}

export interface VerificationEducation {
  id: string;
  institution: string;
  degree: string;
  field: string;
  startYear: number;
  endYear: number | null;
}

export interface VerificationCertification {
  id: string;
  name: string;
  issuer: string;
  issueDate: string;
}

export interface VerificationConsultant {
  profileId: string;
  userId: string;
  name: string | null;
  email: string;
  image: string | null;
  linkedinUrl: string | null;
  bio: string | null;
  domain: string;
  subDomains: { id: string; name: string }[];
  experience: number | null;
  headline: string | null;
  description: string | null;
  isVerified: boolean;
  verificationStatus: string;
  workExperiences: VerificationWorkExperience[];
  education: VerificationEducation[];
  certifications: VerificationCertification[];
}

export interface VerificationDocument {
  id: string;
  fileName: string;
  originalName: string;
  fileSize: number;
  mimeType: string;
  fileUrl: string;
  description: string | null;
}

export interface ProfileVerification {
  id: string;
  status: string;
  submittedAt: string;
  notes: string | null;
  rejectionReason?: string | null;
  feedbackDetails?: string | null;
  consultant: VerificationConsultant;
  documents: VerificationDocument[];
  reviewedAt: string | null;
  reviewedById: string | null;
  reviewNotes: string | null;
}

export interface ModerationReport {
  id: string;
  type: string;
  reason: string;
  description: string | null;
  status: string;
  createdAt: string;
  reporter: {
    id: string;
    name: string | null;
    email: string;
  };
  reportedUser: {
    id: string;
    name: string | null;
    email: string;
    role: string;
  };
  _count?: {
    actions: number;
  };
}

export interface ModerationReview {
  id: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  consultee: {
    id: string;
    name: string | null;
    image: string | null;
  } | null;
  consultation: {
    consultant: {
      user: {
        id: string;
        name: string | null;
        image: string | null;
      } | null;
    } | null;
  } | null;
}

export interface ModerationStats {
  pendingReports: number;
  pendingProfiles: number;
  pendingReviews: number;
  resolvedToday: number;
}
