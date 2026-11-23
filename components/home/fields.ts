import {
  Briefcase,
  Code,
  FileText,
  GraduationCap,
  HeartPulse,
  IndianRupee,
  Languages,
  MessagesSquare,
  Palette,
  Repeat,
  Rocket,
  Sprout,
  type LucideIcon,
} from "lucide-react";

export interface FieldTile {
  /** The domain's name in the database; the tile shows only while it has verified experts. */
  domain: string;
  label: string;
  icon: LucideIcon;
  subtopics: string[];
}

/** The landing page's fields in demand order. A domain missing from this list never gets a tile. */
export const FIELD_TILES: FieldTile[] = [
  {
    domain: "Technology",
    label: "Technology",
    icon: Code,
    subtopics: ["AI & ML", "Data science", "System design"],
  },
  {
    domain: "Business",
    label: "Business & product",
    icon: Briefcase,
    subtopics: ["Product management", "Startups", "Sales & marketing"],
  },
  {
    domain: "Finance",
    label: "Finance",
    icon: IndianRupee,
    subtopics: ["Investing", "Banking", "CA prep"],
  },
  {
    domain: "Creative Arts",
    label: "Creative Arts",
    icon: Palette,
    subtopics: ["Design", "Writing", "Music"],
  },
  {
    domain: "Health",
    label: "Health",
    icon: HeartPulse,
    subtopics: ["Fitness", "Nutrition", "Wellbeing"],
  },
  {
    domain: "Personal Development",
    label: "Personal Development",
    icon: Sprout,
    subtopics: ["Communication", "Leadership", "Productivity"],
  },
  {
    domain: "Languages",
    label: "Languages",
    icon: Languages,
    subtopics: ["IELTS", "English", "Foreign languages"],
  },
  {
    domain: "Education",
    label: "Education",
    icon: GraduationCap,
    subtopics: ["Exam prep", "Tutoring", "Study abroad"],
  },
];

/** Goals that cut across every field, so they sit beside the field tiles rather than among them. */
export const GOAL_LINKS: { label: string; href: string; icon: LucideIcon }[] = [
  {
    label: "Interview prep",
    href: "/explore/experts?search=interview",
    icon: MessagesSquare,
  },
  {
    label: "Resume review",
    href: "/explore/experts?search=resume",
    icon: FileText,
  },
  { label: "Career switch", href: "/use-cases/career-switchers", icon: Repeat },
  { label: "First job", href: "/use-cases/early-career", icon: Rocket },
];
