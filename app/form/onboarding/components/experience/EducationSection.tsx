"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Plus, Pencil, Trash2, GraduationCap, Calendar } from "lucide-react";
import { AddEducationModal } from "./AddEducationModal";

export interface Education {
  id: string;
  institution: string;
  degree: string;
  fieldOfStudy?: string;
  startYear?: number;
  endYear?: number;
  grade?: string;
  activities?: string;
  description?: string;
}

interface EducationSectionProps {
  education: Education[];
  onUpdate: (education: Education[]) => void;
}

export function EducationSection({
  education,
  onUpdate,
}: EducationSectionProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingEducation, setEditingEducation] = useState<Education | null>(
    null,
  );

  const handleSave = (edu: Education | Omit<Education, "id">) => {
    if ("id" in edu && edu.id) {
      // Editing existing education
      onUpdate(
        education.map((e) => (e.id === edu.id ? (edu as Education) : e)),
      );
      setEditingEducation(null);
    } else {
      // Adding new education
      const newEducation: Education = {
        ...edu,
        id: `edu_${Date.now()}`,
      };
      onUpdate([...education, newEducation]);
    }
    setIsModalOpen(false);
  };

  const handleDelete = (id: string) => {
    onUpdate(education.filter((e) => e.id !== id));
  };

  const openEditModal = (edu: Education) => {
    setEditingEducation(edu);
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setEditingEducation(null);
    setIsModalOpen(false);
  };

  const formatYears = (startYear?: number, endYear?: number) => {
    if (startYear && endYear) return `${startYear} - ${endYear}`;
    if (startYear) return `${startYear} - Present`;
    if (endYear) return `Graduated ${endYear}`;
    return "";
  };

  return (
    <div className="space-y-4">
      {education.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <GraduationCap className="w-10 h-10 mx-auto mb-3 opacity-50" />
          <p className="text-sm">No education added yet</p>
          <p className="text-xs mt-1">Add your educational background</p>
        </div>
      ) : (
        <div className="space-y-3">
          {education.map((edu) => (
            <div
              key={edu.id}
              className="group flex items-start gap-4 p-4 rounded-lg border bg-card hover:shadow-sm transition-shadow"
            >
              <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <GraduationCap className="w-5 h-5 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-medium text-foreground">
                  {edu.institution}
                </h4>
                <p className="text-sm text-muted-foreground">
                  {edu.degree}
                  {edu.fieldOfStudy && ` in ${edu.fieldOfStudy}`}
                </p>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                  {(edu.startYear || edu.endYear) && (
                    <span className="flex items-center gap-1">
                      <Calendar className="w-3 h-3" />
                      {formatYears(edu.startYear, edu.endYear)}
                    </span>
                  )}
                  {edu.grade && (
                    <span className="text-primary font-medium">
                      Grade: {edu.grade}
                    </span>
                  )}
                </div>
                {edu.description && (
                  <p className="mt-2 text-sm text-muted-foreground line-clamp-2">
                    {edu.description}
                  </p>
                )}
              </div>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => openEditModal(edu)}
                >
                  <Pencil className="w-4 h-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive hover:text-destructive"
                  onClick={() => handleDelete(edu.id)}
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
        Add Education
      </Button>

      <AddEducationModal
        isOpen={isModalOpen}
        onClose={closeModal}
        onSave={handleSave}
        education={editingEducation}
      />
    </div>
  );
}
