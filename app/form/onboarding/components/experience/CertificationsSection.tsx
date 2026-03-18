"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Plus,
  Pencil,
  Trash2,
  Award,
  Calendar,
  ExternalLink,
} from "lucide-react";
import { AddCertificationModal } from "./AddCertificationModal";
import { format } from "date-fns";

export interface Certification {
  id: string;
  name: string;
  issuingOrganization: string;
  issueDate: Date;
  expiryDate?: Date | null;
  credentialId?: string;
  credentialUrl?: string;
}

interface CertificationsSectionProps {
  certifications: Certification[];
  onUpdate: (certifications: Certification[]) => void;
}

export function CertificationsSection({
  certifications,
  onUpdate,
}: CertificationsSectionProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingCertification, setEditingCertification] =
    useState<Certification | null>(null);

  const handleSave = (
    certification: Certification | Omit<Certification, "id">,
  ) => {
    if ("id" in certification && certification.id) {
      // Editing: narrow union after runtime "id" in check — TS can't prove this
      onUpdate(
        certifications.map((c) =>
          c.id === certification.id ? (certification as Certification) : c,
        ),
      );
      setEditingCertification(null);
    } else {
      // Adding new certification
      const newCertification: Certification = {
        ...certification,
        id: `cert_${Date.now()}`,
      };
      onUpdate([...certifications, newCertification]);
    }
    setIsModalOpen(false);
  };

  const handleDelete = (id: string) => {
    onUpdate(certifications.filter((c) => c.id !== id));
  };

  const openEditModal = (certification: Certification) => {
    setEditingCertification(certification);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setEditingCertification(null);
    setIsModalOpen(false);
  };

  const formatDate = (date: Date) => {
    return format(new Date(date), "MMM yyyy");
  };

  const isExpired = (expiryDate?: Date | null) => {
    if (!expiryDate) return false;
    return new Date(expiryDate) < new Date();
  };

  return (
    <div className="space-y-4">
      {certifications.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <Award className="w-10 h-10 mx-auto mb-3 opacity-50" />
          <p className="text-sm">No certifications added yet</p>
          <p className="text-xs mt-1">
            Add your professional certifications and licenses
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {certifications.map((cert) => (
            <div
              key={cert.id}
              className="group flex items-start gap-4 p-4 rounded-lg border bg-card hover:shadow-sm transition-shadow"
            >
              <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <Award className="w-5 h-5 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="font-medium text-foreground">{cert.name}</h4>
                  {isExpired(cert.expiryDate) && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-destructive/10 text-destructive">
                      Expired
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  {cert.issuingOrganization}
                </p>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    Issued {formatDate(cert.issueDate)}
                    {cert.expiryDate &&
                      ` · Expires ${formatDate(cert.expiryDate)}`}
                  </span>
                </div>
                {cert.credentialId && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Credential ID: {cert.credentialId}
                  </p>
                )}
                {cert.credentialUrl && (
                  <a
                    href={cert.credentialUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 mt-2 text-xs text-primary hover:underline"
                  >
                    View Credential
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => openEditModal(cert)}
                >
                  <Pencil className="w-4 h-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={() => handleDelete(cert.id)}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => setIsModalOpen(true)}
      >
        <Plus className="w-4 h-4 mr-2" />
        Add Certification
      </Button>

      <AddCertificationModal
        isOpen={isModalOpen}
        onClose={closeModal}
        onSave={handleSave}
        certification={editingCertification}
      />
    </div>
  );
}
