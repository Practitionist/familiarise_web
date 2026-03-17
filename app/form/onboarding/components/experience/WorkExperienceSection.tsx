"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Plus,
  Pencil,
  Trash2,
  Building2,
  MapPin,
  Calendar,
} from "lucide-react";
import { AddWorkExperienceModal } from "./AddWorkExperienceModal";
import { CompanyLogo } from "@/components/ui/company-logo";
import { format } from "date-fns";

export interface WorkExperience {
  id: string;
  company: string;
  companyDomain?: string;
  title: string;
  location?: string;
  startDate: Date;
  endDate?: Date;
  isCurrent: boolean;
  description?: string;
}

interface WorkExperienceSectionProps {
  experiences: WorkExperience[];
  onUpdate: (experiences: WorkExperience[]) => void;
}

export function WorkExperienceSection({
  experiences,
  onUpdate,
}: WorkExperienceSectionProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingExperience, setEditingExperience] =
    useState<WorkExperience | null>(null);

  const handleSave = (
    experience: WorkExperience | Omit<WorkExperience, "id">,
  ) => {
    if ("id" in experience && experience.id) {
      // Editing existing experience
      onUpdate(
        experiences.map((e) =>
          e.id === experience.id ? (experience as WorkExperience) : e,
        ),
      );
      setEditingExperience(null);
    } else {
      // Adding new experience
      const newExperience: WorkExperience = {
        ...experience,
        id: `work_${Date.now()}`,
      };
      onUpdate([...experiences, newExperience]);
    }
    setIsModalOpen(false);
  };

  const handleDelete = (id: string) => {
    onUpdate(experiences.filter((e) => e.id !== id));
  };

  const openEditModal = (experience: WorkExperience) => {
    setEditingExperience(experience);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setEditingExperience(null);
    setIsModalOpen(false);
  };

  const formatDateRange = (
    startDate: Date,
    endDate?: Date,
    isCurrent?: boolean,
  ) => {
    const startDateObj = new Date(startDate);
    // Guard against invalid dates
    if (isNaN(startDateObj.getTime())) {
      return isCurrent ? "Present" : "Date not set";
    }
    const start = format(startDateObj, "MMM yyyy");
    if (isCurrent) return `${start} - Present`;
    if (endDate) {
      const endDateObj = new Date(endDate);
      if (!isNaN(endDateObj.getTime())) {
        return `${start} - ${format(endDateObj, "MMM yyyy")}`;
      }
    }
    return start;
  };

  return (
    <div className="space-y-4">
      {experiences.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <Building2 className="w-10 h-10 mx-auto mb-3 opacity-50" />
          <p className="text-sm">No work experience added yet</p>
          <p className="text-xs mt-1">
            Add your professional experience to build credibility
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {experiences.map((exp) => (
            <div
              key={exp.id}
              className="group flex items-start gap-4 p-4 rounded-lg border bg-card hover:shadow-sm transition-shadow"
            >
              <CompanyLogo
                companyDomain={exp.companyDomain}
                companyName={exp.company}
                size={40}
              />
              <div className="flex-1 min-w-0">
                <h4 className="font-medium text-foreground">{exp.title}</h4>
                <p className="text-sm text-muted-foreground">{exp.company}</p>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                  {exp.location && (
                    <span className="flex items-center gap-1">
                      <MapPin className="w-3 h-3" />
                      {exp.location}
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3 h-3" />
                    {formatDateRange(exp.startDate, exp.endDate, exp.isCurrent)}
                  </span>
                </div>
                {exp.description && (
                  <p className="mt-2 text-sm text-muted-foreground line-clamp-2">
                    {exp.description}
                  </p>
                )}
              </div>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => openEditModal(exp)}
                >
                  <Pencil className="w-4 h-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={() => handleDelete(exp.id)}
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
        Add Work Experience
      </Button>

      <AddWorkExperienceModal
        isOpen={isModalOpen}
        onClose={closeModal}
        onSave={handleSave}
        experience={editingExperience}
      />
    </div>
  );
}
