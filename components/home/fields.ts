import {
  BrainCircuit,
  Briefcase,
  ChartLine,
  Code,
  FileText,
  GraduationCap,
  HeartPulse,
  IndianRupee,
  Languages,
  Megaphone,
  MessagesSquare,
  PenTool,
  Palette,
  Repeat,
  Rocket,
  Salad,
  Sprout,
  SquareKanban,
  type LucideIcon,
} from "lucide-react";

export interface FieldPhoto {
  /** A file under public/, optimised by next/image. */
  src: string;
  alt: string;
  /** Where the photo came from and under which licence, kept for provenance. */
  credit: string;
}

export interface FieldTile {
  /** The domain's name in the database; the tile shows only while it has verified experts. */
  domain: string;
  label: string;
  icon: LucideIcon;
  subtopics: string[];
  /** Without a photo the tile falls back to the dark dot-grid style. */
  photo?: FieldPhoto;
}

export interface SubtopicTile {
  label: string;
  /** Shown only while this field has verified experts. */
  domain: string;
  /** A free-text search of the experts directory. */
  search: string;
  icon: LucideIcon;
}

/** The landing page's fields in demand order. A domain missing from this list never gets a tile. */
export const FIELD_TILES: FieldTile[] = [
  {
    domain: "Technology",
    label: "Technology",
    icon: Code,
    subtopics: ["AI & ML", "Data science", "System design"],
    photo: {
      src: "/images/fields/technology.webp",
      alt: "A tidy desk with a keyboard, tablet and notebook seen from above",
      credit:
        "Vadim Sherbakov, Unsplash (unsplash.com/photos/Hi9GSwWkCJk), via Lorem Picsum",
    },
  },
  {
    domain: "Business",
    label: "Business & product",
    icon: Briefcase,
    subtopics: ["Product management", "Startups", "Sales & marketing"],
    photo: {
      src: "/images/fields/business.webp",
      alt: "A wallet, notebook, watch and other work essentials laid out on a desk",
      credit:
        "Vadim Sherbakov, Unsplash (unsplash.com/photos/tCICLJ5ktBE), via Lorem Picsum",
    },
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
    photo: {
      src: "/images/fields/creative-arts.webp",
      alt: "A hand adjusting faders on a music mixing desk",
      credit:
        "Drew Patrick Miller, Unsplash (unsplash.com/photos/_o6AAx9dl_Y), via Lorem Picsum",
    },
  },
  {
    domain: "Health",
    label: "Health",
    icon: HeartPulse,
    subtopics: ["Fitness", "Nutrition", "Wellbeing"],
    photo: {
      src: "/images/fields/health.webp",
      alt: "Fresh vegetables and peppercorns on a chopping board",
      credit:
        "Webvilla, Unsplash (unsplash.com/photos/hv1MrBzGGNY), via Lorem Picsum",
    },
  },
  {
    domain: "Personal Development",
    label: "Personal Development",
    icon: Sprout,
    subtopics: ["Communication", "Leadership", "Productivity"],
    photo: {
      src: "/images/fields/personal-development.webp",
      alt: "An open book on a wooden table",
      credit:
        "Alejandro Escamilla, Unsplash (unsplash.com/photos/cZhUxIQjILg), via Lorem Picsum",
    },
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

/** Popular subtopics inside the fields above, as smaller tiles after the field tiles. */
export const SUBTOPIC_TILES: SubtopicTile[] = [
  { label: "AI & ML", domain: "Technology", search: "AI", icon: BrainCircuit },
  {
    label: "Data science",
    domain: "Technology",
    search: "data",
    icon: ChartLine,
  },
  {
    label: "Product management",
    domain: "Business",
    search: "product",
    icon: SquareKanban,
  },
  {
    label: "UI/UX design",
    domain: "Creative Arts",
    search: "design",
    icon: PenTool,
  },
  {
    label: "Public speaking",
    domain: "Personal Development",
    search: "speaking",
    icon: Megaphone,
  },
  {
    label: "Nutrition",
    domain: "Health",
    search: "nutrition",
    icon: Salad,
  },
];
