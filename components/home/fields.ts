import {
  FileText,
  MessagesSquare,
  Repeat,
  Rocket,
  type LucideIcon,
} from "lucide-react";

export interface FieldPhoto {
  /** A file under public/, optimised by next/image. */
  src: string;
  alt: string;
  /** Where the photo came from and under which licence, kept for provenance. */
  credit: string;
}

export interface FieldDetail {
  /** One line on what learners get, shown on the field's category page. */
  tagline: string;
  /** Popular topics inside the field; each opens a search of the field's experts. */
  topics: string[];
  /** Tailwind gradient classes for the field's tinted surfaces. */
  tint: string;
  photo?: FieldPhoto;
}

const PHOTOS = {
  technology: {
    src: "/images/fields/technology.webp",
    alt: "A tidy desk with a keyboard, tablet and notebook seen from above",
    credit:
      "Vadim Sherbakov, Unsplash (unsplash.com/photos/Hi9GSwWkCJk), via Lorem Picsum",
  },
  business: {
    src: "/images/fields/business.webp",
    alt: "A wallet, notebook, watch and other work essentials laid out on a desk",
    credit:
      "Vadim Sherbakov, Unsplash (unsplash.com/photos/tCICLJ5ktBE), via Lorem Picsum",
  },
  creativeArts: {
    src: "/images/fields/creative-arts.webp",
    alt: "A hand adjusting faders on a music mixing desk",
    credit:
      "Drew Patrick Miller, Unsplash (unsplash.com/photos/_o6AAx9dl_Y), via Lorem Picsum",
  },
  health: {
    src: "/images/fields/health.webp",
    alt: "Fresh vegetables and peppercorns on a chopping board",
    credit:
      "Webvilla, Unsplash (unsplash.com/photos/hv1MrBzGGNY), via Lorem Picsum",
  },
  personalDevelopment: {
    src: "/images/fields/personal-development.webp",
    alt: "An open book on a wooden table",
    credit:
      "Alejandro Escamilla, Unsplash (unsplash.com/photos/cZhUxIQjILg), via Lorem Picsum",
  },
} satisfies Record<string, FieldPhoto>;

/** Per-field copy, topics, tint and photo, keyed by the domain's name in the database. */
export const FIELD_DETAILS: Record<string, FieldDetail> = {
  Technology: {
    tagline: "Learn from engineers who build and ship software every day.",
    topics: [
      "AI & ML",
      "Data science",
      "System design",
      "Web development",
      "Cloud",
    ],
    tint: "from-sky-100 via-sky-50 to-cyan-100",
    photo: PHOTOS.technology,
  },
  Business: {
    tagline: "Product, growth and strategy advice from people who run them.",
    topics: ["Product management", "Startups", "Sales & marketing", "Strategy"],
    tint: "from-emerald-50 via-teal-50 to-emerald-100",
    photo: PHOTOS.business,
  },
  Finance: {
    tagline: "Make sense of money with people who manage it for a living.",
    topics: ["Investing", "Banking", "CA prep", "Personal finance"],
    tint: "from-emerald-50 via-teal-50 to-emerald-100",
  },
  "Creative Arts": {
    tagline:
      "Feedback on your work from practising designers, writers and musicians.",
    topics: ["UI/UX design", "Writing", "Music", "Photography"],
    tint: "from-rose-100 via-pink-50 to-rose-50",
    photo: PHOTOS.creativeArts,
  },
  Health: {
    tagline: "Fitness, nutrition and wellbeing coaching from practitioners.",
    topics: ["Fitness", "Nutrition", "Wellbeing", "Yoga"],
    tint: "from-lime-100 via-lime-50 to-green-50",
    photo: PHOTOS.health,
  },
  "Personal Development": {
    tagline: "Grow how you speak, lead and work, one session at a time.",
    topics: ["Public speaking", "Leadership", "Communication", "Productivity"],
    tint: "from-lime-100 via-lime-50 to-green-50",
    photo: PHOTOS.personalDevelopment,
  },
  Languages: {
    tagline: "Speak with confidence, from IELTS prep to a new language.",
    topics: ["IELTS", "English", "Foreign languages"],
    tint: "from-sky-100 via-sky-50 to-cyan-100",
  },
  Education: {
    tagline: "Tutoring and exam prep from teachers who know the syllabus.",
    topics: ["Exam prep", "Tutoring", "Study abroad"],
    tint: "from-rose-100 via-pink-50 to-rose-50",
  },
};

/** The field's details, matched on the domain name without regard to case. */
export function fieldDetail(domainName: string): FieldDetail | undefined {
  const key = Object.keys(FIELD_DETAILS).find(
    (name) => name.toLowerCase() === domainName.toLowerCase(),
  );
  return key ? FIELD_DETAILS[key] : undefined;
}

export type FieldMockup = "live" | "slots" | "review" | "progress";

export interface FieldGroup {
  title: string;
  benefit: string;
  /** Domains in the database this tile covers; it shows while any has verified experts. */
  domains: string[];
  /** Fills the whole tile under a dark gradient. */
  photo: FieldPhoto;
  mockup: FieldMockup;
}

/** The landing page's four field tiles, in demand order. Domains outside these groups never get a tile. */
export const FIELD_GROUPS: FieldGroup[] = [
  {
    title: "Technology",
    benefit: "Learn from engineers who build and ship software every day.",
    domains: ["Technology"],
    photo: PHOTOS.technology,
    mockup: "live",
  },
  {
    title: "Business & finance",
    benefit: "Product, growth and money advice from people who run them.",
    domains: ["Business", "Finance"],
    photo: PHOTOS.business,
    mockup: "slots",
  },
  {
    title: "Creative Arts",
    benefit: "Honest feedback on your work from practising creatives.",
    domains: ["Creative Arts"],
    photo: PHOTOS.creativeArts,
    mockup: "review",
  },
  {
    title: "Health & personal growth",
    benefit: "Coaching for body and mind, one session at a time.",
    domains: ["Health", "Personal Development"],
    photo: PHOTOS.health,
    mockup: "progress",
  },
];

/** Goals that cut across every field, so they sit below the field tiles rather than among them. */
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
