"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  WorkExperienceSection,
  type WorkExperience,
} from "./experience/WorkExperienceSection";
import {
  EducationSection,
  type Education,
} from "./experience/EducationSection";
import {
  CertificationsSection,
  type Certification,
} from "./experience/CertificationsSection";
import {
  Briefcase,
  GraduationCap,
  Award,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { OnboardingFormData } from "@/utils/onboarding";

interface ProfessionalBackgroundFormProps {
  onNext: (data: Partial<OnboardingFormData>) => void;
  onBack: () => void;
  initialData?: Partial<OnboardingFormData>;
}

export default function ProfessionalBackgroundForm({
  onNext,
  onBack,
  initialData,
}: ProfessionalBackgroundFormProps) {
  // Ensure all items have IDs (generate if missing from initialData)
  const [workExperiences, setWorkExperiences] = useState<WorkExperience[]>(
    () =>
      (initialData?.workExperiences || []).map((exp, i) => ({
        ...exp,
        id: exp.id || `work_init_${i}`,
      })) as WorkExperience[],
  );
  const [education, setEducation] = useState<Education[]>(
    () =>
      (initialData?.educationHistory || []).map((edu, i) => ({
        ...edu,
        id: edu.id || `edu_init_${i}`,
      })) as Education[],
  );
  const [certifications, setCertifications] = useState<Certification[]>(
    () =>
      (initialData?.certificationsList || []).map((cert, i) => ({
        ...cert,
        id: cert.id || `cert_init_${i}`,
      })) as Certification[],
  );

  const handleSubmit = () => {
    onNext({
      workExperiences,
      educationHistory: education,
      certificationsList: certifications,
    });
  };

  return (
    <div className="space-y-6">
      <div className="text-center mb-6">
        <p className="text-sm text-muted-foreground">
          Add your professional background to help potential mentees learn more
          about your experience. You can skip this step and add details later.
        </p>
      </div>

      {/* Work Experience Section */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Briefcase className="w-5 h-5 text-primary" />
            Work Experience
          </CardTitle>
        </CardHeader>
        <CardContent>
          <WorkExperienceSection
            experiences={workExperiences}
            onUpdate={setWorkExperiences}
          />
        </CardContent>
      </Card>

      {/* Education Section */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <GraduationCap className="w-5 h-5 text-primary" />
            Education
          </CardTitle>
        </CardHeader>
        <CardContent>
          <EducationSection education={education} onUpdate={setEducation} />
        </CardContent>
      </Card>

      {/* Certifications Section */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Award className="w-5 h-5 text-primary" />
            Certifications
          </CardTitle>
        </CardHeader>
        <CardContent>
          <CertificationsSection
            certifications={certifications}
            onUpdate={setCertifications}
          />
        </CardContent>
      </Card>

      {/* Navigation */}
      <div className="flex justify-between pt-4">
        <Button type="button" variant="outline" onClick={onBack}>
          <ChevronLeft className="w-4 h-4 mr-2" />
          Back
        </Button>
        <Button type="button" onClick={handleSubmit}>
          Continue
          <ChevronRight className="w-4 h-4 ml-2" />
        </Button>
      </div>
    </div>
  );
}
