import { fireEvent, render, screen } from "@testing-library/react";

jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import VerificationReviewModal from "@/components/admin/VerificationReviewModal";
import type { VerificationItem } from "@/lib/backoffice/people-list-schemas";

function applicant(documentCount: number): VerificationItem {
  return {
    id: "v1",
    status: "PENDING",
    submittedAt: "2026-11-16T09:00:00.000Z",
    notes: null,
    consultant: {
      profileId: "cp-1",
      userId: "u-1",
      name: "Aarav Anderson",
      email: "a@example.test",
      image: null,
      linkedinUrl: null,
      bio: null,
      domain: "Careers",
      subDomains: [],
      experience: 3,
      headline: null,
      description: null,
      isVerified: false,
      verificationStatus: "PENDING_VERIFICATION",
      workExperiences: [],
      education: [],
      certifications: [],
    },
    documents: Array.from({ length: documentCount }, (_, i) => ({
      id: `d${i}`,
      fileName: `file-${i}.pdf`,
      originalName: `file-${i}.pdf`,
      fileSize: 1000,
      mimeType: "application/pdf",
      description: `Degree ${i}`,
    })),
    reviewedAt: null,
    reviewedById: null,
    reviewNotes: null,
  };
}

function renderModal(documentCount: number) {
  render(
    <VerificationReviewModal
      verification={applicant(documentCount)}
      open
      onOpenChange={jest.fn()}
      onVerificationComplete={jest.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText(/Reason for the audit log/), {
    target: { value: "ID and degree match" },
  });
}

describe("VerificationReviewModal approval", () => {
  it("keeps Approve off with no documents, even with a valid reason", () => {
    renderModal(0);
    expect(screen.getByText(/No documents are attached/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Approve$/ })).toBeDisabled();
  });

  it("enables Approve with a document and a valid reason", () => {
    renderModal(1);
    expect(
      screen.queryByText(/No documents are attached/),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Approve$/ })).toBeEnabled();
  });
});
