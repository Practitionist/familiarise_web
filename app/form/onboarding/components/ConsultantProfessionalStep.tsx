"use client";

import { useState, useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import ConsultantProfileForm from "./ConsultantProfileForm";
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
import AchievementsSection, {
  type Achievement,
} from "./experience/AchievementsSection";
import {
  Briefcase,
  GraduationCap,
  Award,
  Trophy,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { OnboardingFormData } from "@/utils/onboarding";
import type { PersonalInfoAndRole } from "@/schemas/user";

interface ConsultantProfessionalStepProps {
  onNext: (data: Partial<OnboardingFormData>) => void;
  onBack: () => void;
  initialData: Partial<OnboardingFormData>;
  personalInfo: PersonalInfoAndRole;
}

export default function ConsultantProfessionalStep({
  onNext,
  onBack,
  initialData,
  personalInfo,
}: ConsultantProfessionalStepProps) {
  const [activeTab, setActiveTab] = useState("expertise");
  const [expertiseData, setExpertiseData] =
    useState<Partial<OnboardingFormData> | null>(null);

  // Professional background state
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
  const [achievements, setAchievements] = useState<Achievement[]>(
    () =>
      (initialData?.achievements || []).map((ach, i) => ({
        ...ach,
        id: (ach as any).id || `ach_init_${i}`,
      })) as Achievement[],
  );

  // If expertise data was already filled (coming back), pre-populate
  useEffect(() => {
    if (initialData?.domain) {
      setExpertiseData(initialData);
    }
  }, [initialData]);

  // Sync professional background state when initialData changes (back navigation)
  useEffect(() => {
    if (initialData) {
      setWorkExperiences(
        (initialData.workExperiences || []).map((exp, i) => ({
          ...exp,
          id: exp.id || `work_init_${i}`,
        })) as WorkExperience[],
      );
      setEducation(
        (initialData.educationHistory || []).map((edu, i) => ({
          ...edu,
          id: edu.id || `edu_init_${i}`,
        })) as Education[],
      );
      setCertifications(
        (initialData.certificationsList || []).map((cert, i) => ({
          ...cert,
          id: cert.id || `cert_init_${i}`,
        })) as Certification[],
      );
      setAchievements(
        (initialData.achievements || []).map((ach, i) => ({
          ...ach,
          id: (ach as any).id || `ach_init_${i}`,
        })) as Achievement[],
      );
    }
  }, [initialData]);

  const handleExpertiseNext = (data: Partial<OnboardingFormData>) => {
    setExpertiseData(data);
    setActiveTab("experience");
  };

  const handleFinalNext = () => {
    onNext({
      ...expertiseData,
      workExperiences,
      educationHistory: education,
      certificationsList: certifications,
      achievements: achievements.map(({ id: _id, ...rest }) => ({
        ...rest,
        achievementType: rest.achievementType as
          | "AWARD"
          | "PUBLICATION"
          | "PROJECT"
          | "TALK"
          | "OPEN_SOURCE"
          | "OTHER",
      })),
    });
  };

  return (
    <div className="space-y-4">
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="expertise">Expertise & Domain</TabsTrigger>
          <TabsTrigger value="experience" disabled={!expertiseData}>
            Experience & Credentials
          </TabsTrigger>
        </TabsList>

        <TabsContent value="expertise" className="mt-4">
          <ConsultantProfileForm
            onNext={handleExpertiseNext}
            onBack={onBack}
            initialData={expertiseData || initialData}
            personalInfo={personalInfo}
          />
        </TabsContent>

        <TabsContent value="experience" className="mt-4">
          <div className="space-y-6">
            <div className="text-center mb-4">
              <p className="text-sm text-muted-foreground">
                Add your professional background to help consultees learn more
                about your experience. You can skip and add details later.
              </p>
            </div>

            {/* Work Experience */}
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

            {/* Education */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <GraduationCap className="w-5 h-5 text-primary" />
                  Education
                </CardTitle>
              </CardHeader>
              <CardContent>
                <EducationSection
                  education={education}
                  onUpdate={setEducation}
                />
              </CardContent>
            </Card>

            {/* Certifications */}
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

            {/* Achievements */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Trophy className="w-5 h-5 text-primary" />
                  Achievements & Portfolio
                </CardTitle>
              </CardHeader>
              <CardContent>
                <AchievementsSection
                  achievements={achievements}
                  onUpdate={setAchievements}
                />
              </CardContent>
            </Card>

            {/* Navigation */}
            <div className="flex justify-between pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setActiveTab("expertise")}
              >
                <ChevronLeft className="w-4 h-4 mr-2" />
                Back to Expertise
              </Button>
              <Button type="button" onClick={handleFinalNext}>
                Continue
                <ChevronRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
