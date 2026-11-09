import type { ElementType } from "react";
import {
  Search,
  Users,
  GraduationCap,
  Briefcase,
  ArrowRightLeft,
  UserCheck,
  Building2,
  Mail,
  Presentation,
  Star,
  FileText,
  BookOpen,
} from "lucide-react";
import { domainPath } from "@/lib/explore/domain-slug";

export interface NavDropdownItem {
  label: string;
  href: string;
  description: string;
  icon: ElementType;
  /** Not yet available: renders a "Soon" pill and does not navigate. */
  disabled?: boolean;
}

export interface NavCategoryChip {
  label: string;
  href: string;
}

/** A titled column inside a mega-menu panel. */
export interface NavColumn {
  heading: string;
  items: NavDropdownItem[];
}

export interface NavDropdownGroup {
  label: string;
  /** Single-column panel (w-80) vs multi-column mega panel. */
  variant: "list" | "mega";
  columns: NavColumn[];
  categoryChips?: NavCategoryChip[];
  categoryHeading?: string;
}

export interface NavFlatLink {
  label: string;
  href: string;
}

// Every entry is a distinct destination. A filtered view of a listing is only
// here when it is a page of its own (a field page), never an in-page anchor.
const EXPLORE_COLUMNS: NavColumn[] = [
  {
    heading: "Experts",
    items: [
      {
        label: "All experts",
        href: "/explore/experts",
        description: "Verified consultants across every field",
        icon: Search,
      },
      {
        label: "Top rated",
        href: "/explore/experts?sort=rating",
        description: "Highest-rated experts on Familiarise",
        icon: Star,
      },
    ],
  },
  {
    heading: "Live programs",
    items: [
      {
        label: "Classes",
        href: "/explore/programs?tab=class",
        description: "Multi-session classes with a curriculum",
        icon: GraduationCap,
      },
      {
        label: "Webinars",
        href: "/explore/programs?tab=webinar",
        description: "Single live sessions with an expert",
        icon: Presentation,
      },
    ],
  },
  {
    heading: "Library",
    items: [
      {
        label: "Digital products",
        href: "/explore/products",
        description: "E-books, templates and packs. Pay once, keep it",
        icon: FileText,
      },
      {
        label: "Courses",
        href: "/explore/products",
        description: "Graded courses with quizzes and capstones",
        icon: BookOpen,
        disabled: true,
      },
      {
        label: "Partner organisations",
        href: "/explore/enterprise/organisations",
        description: "Expert networks and institutions",
        icon: Building2,
      },
    ],
  },
];

export const EXPLORE_FIELDS = [
  "Technology",
  "Business",
  "Creative Arts",
  "Education",
  "Health",
  "Personal Development",
] as const;

export const EXPLORE_CATEGORIES: NavCategoryChip[] = EXPLORE_FIELDS.map(
  (name) => ({
    label: name === "Personal Development" ? "Personal Dev" : name,
    href: domainPath(name),
  }),
);

// B2C use cases only. B2B lives under For business.
const SOLUTIONS_COLUMNS: NavColumn[] = [
  {
    heading: "By goal",
    items: [
      {
        label: "College students",
        href: "/use-cases/college-students",
        description: "Get career guidance before you graduate",
        icon: GraduationCap,
      },
      {
        label: "Early-career professionals",
        href: "/use-cases/early-career",
        description: "Accelerate your first 1–5 years",
        icon: Briefcase,
      },
      {
        label: "Career switchers",
        href: "/use-cases/career-switchers",
        description: "Navigate the service-to-product transition",
        icon: ArrowRightLeft,
      },
      {
        label: "Long-term mentorship",
        href: "/use-cases/mentorship",
        description: "Ongoing guidance from industry experts",
        icon: UserCheck,
      },
    ],
  },
];

const BUSINESS_COLUMNS: NavColumn[] = [
  {
    heading: "For business",
    items: [
      {
        label: "Overview",
        href: "/enterprise",
        description: "Familiarise for organisations",
        icon: Building2,
      },
      {
        label: "Team training",
        href: "/enterprise/team-training",
        description: "Licensed seats for a whole cohort",
        icon: GraduationCap,
      },
      {
        label: "Corporate mentorship",
        href: "/enterprise/corporate-mentorship",
        description: "Credit pools for 1:1 expert sessions",
        icon: Users,
      },
      {
        label: "Book a demo",
        href: "/enterprise/demo",
        description: "Tell us what your organisation needs",
        icon: Mail,
      },
    ],
  },
];

export const NAV_GROUPS: NavDropdownGroup[] = [
  {
    label: "Explore",
    variant: "mega",
    columns: EXPLORE_COLUMNS,
    categoryChips: EXPLORE_CATEGORIES,
    categoryHeading: "Browse by field",
  },
  { label: "Solutions", variant: "list", columns: SOLUTIONS_COLUMNS },
  { label: "For business", variant: "list", columns: BUSINESS_COLUMNS },
];

/** Plain links after the dropdowns: the supply-side entry point belongs in the bar. */
export const NAV_FLAT_LINKS: NavFlatLink[] = [
  { label: "Become an expert", href: "/become-an-expert" },
];
