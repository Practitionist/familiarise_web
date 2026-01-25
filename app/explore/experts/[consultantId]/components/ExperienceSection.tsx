"use client";

import { Briefcase, GraduationCap, Award, Calendar, MapPin } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { WorkExperience, Education, Certification } from "@prisma/client";

interface ExperienceSectionProps {
  workExperiences: WorkExperience[];
  education: Education[];
  certifications: Certification[];
}

function formatDate(date: Date | null | undefined): string {
  if (!date) return "";
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });
}

function formatDateRange(
  startDate: Date | null | undefined,
  endDate: Date | null | undefined,
  isCurrent?: boolean
): string {
  const start = formatDate(startDate);
  if (isCurrent) return `${start} - Present`;
  const end = formatDate(endDate);
  return end ? `${start} - ${end}` : start;
}

function formatYearRange(startYear: number | null, endYear: number | null): string {
  if (!startYear && !endYear) return "";
  if (!endYear) return `${startYear} - Present`;
  if (!startYear) return `${endYear}`;
  return `${startYear} - ${endYear}`;
}

function WorkExperienceCard({ experience }: { experience: WorkExperience }) {
  return (
    <div className="flex gap-4 pb-4 last:pb-0 border-b last:border-b-0 border-zinc-100">
      <div className="flex-shrink-0 w-12 h-12 rounded-lg bg-zinc-100 flex items-center justify-center">
        <Briefcase className="w-5 h-5 text-zinc-500" />
      </div>
      <div className="flex-1 min-w-0">
        <h4 className="font-semibold text-zinc-900">{experience.title}</h4>
        <p className="text-zinc-600">{experience.company}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-sm text-zinc-500">
          <span className="flex items-center gap-1">
            <Calendar className="w-3.5 h-3.5" />
            {formatDateRange(experience.startDate, experience.endDate, experience.isCurrent)}
          </span>
          {experience.location && (
            <span className="flex items-center gap-1">
              <MapPin className="w-3.5 h-3.5" />
              {experience.location}
            </span>
          )}
        </div>
        {experience.description && (
          <p className="mt-2 text-sm text-zinc-600 line-clamp-3">
            {experience.description}
          </p>
        )}
      </div>
    </div>
  );
}

function EducationCard({ education }: { education: Education }) {
  return (
    <div className="flex gap-4 pb-4 last:pb-0 border-b last:border-b-0 border-zinc-100">
      <div className="flex-shrink-0 w-12 h-12 rounded-lg bg-blue-50 flex items-center justify-center">
        <GraduationCap className="w-5 h-5 text-blue-500" />
      </div>
      <div className="flex-1 min-w-0">
        <h4 className="font-semibold text-zinc-900">{education.degree}</h4>
        <p className="text-zinc-600">{education.institution}</p>
        {education.fieldOfStudy && (
          <p className="text-sm text-zinc-500">{education.fieldOfStudy}</p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-sm text-zinc-500">
          <span className="flex items-center gap-1">
            <Calendar className="w-3.5 h-3.5" />
            {formatYearRange(education.startYear, education.endYear)}
          </span>
          {education.grade && (
            <span>Grade: {education.grade}</span>
          )}
        </div>
        {education.activities && (
          <p className="mt-2 text-sm text-zinc-600 line-clamp-2">
            {education.activities}
          </p>
        )}
      </div>
    </div>
  );
}

function CertificationBadge({ certification }: { certification: Certification }) {
  return (
    <div className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-100">
      <Award className="w-4 h-4 text-amber-600 flex-shrink-0" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-zinc-900 truncate">
          {certification.name}
        </p>
        <p className="text-xs text-zinc-500 truncate">
          {certification.issuingOrganization}
        </p>
      </div>
    </div>
  );
}

export function ExperienceSection({
  workExperiences,
  education,
  certifications,
}: ExperienceSectionProps) {
  // Don't render if all sections are empty
  if (
    workExperiences.length === 0 &&
    education.length === 0 &&
    certifications.length === 0
  ) {
    return null;
  }

  return (
    <div className="bg-white rounded-2xl border border-zinc-200 p-6 md:p-8 space-y-8">
      {/* Work Experience */}
      {workExperiences.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Briefcase className="w-5 h-5 text-zinc-600" />
            <h3 className="text-lg font-semibold text-zinc-900">Experience</h3>
            <Badge variant="secondary" className="ml-auto">
              {workExperiences.length}
            </Badge>
          </div>
          <div className="space-y-4">
            {workExperiences
              .sort((a, b) => {
                // Sort by isCurrent first, then by startDate
                if (a.isCurrent && !b.isCurrent) return -1;
                if (!a.isCurrent && b.isCurrent) return 1;
                return new Date(b.startDate).getTime() - new Date(a.startDate).getTime();
              })
              .map((exp) => (
                <WorkExperienceCard key={exp.id} experience={exp} />
              ))}
          </div>
        </div>
      )}

      {/* Education */}
      {education.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <GraduationCap className="w-5 h-5 text-zinc-600" />
            <h3 className="text-lg font-semibold text-zinc-900">Education</h3>
            <Badge variant="secondary" className="ml-auto">
              {education.length}
            </Badge>
          </div>
          <div className="space-y-4">
            {education
              .sort((a, b) => (b.endYear || 9999) - (a.endYear || 9999))
              .map((edu) => (
                <EducationCard key={edu.id} education={edu} />
              ))}
          </div>
        </div>
      )}

      {/* Certifications */}
      {certifications.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-4">
            <Award className="w-5 h-5 text-zinc-600" />
            <h3 className="text-lg font-semibold text-zinc-900">Certifications</h3>
            <Badge variant="secondary" className="ml-auto">
              {certifications.length}
            </Badge>
          </div>
          <div className="flex flex-wrap gap-2">
            {certifications
              .sort((a, b) => new Date(b.issueDate).getTime() - new Date(a.issueDate).getTime())
              .map((cert) => (
                <CertificationBadge key={cert.id} certification={cert} />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
