"use client";

import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronDown,
  Menu,
  X,
  Search,
  Users,
  GraduationCap,
  Briefcase,
  ArrowRightLeft,
  UserCheck,
  Building2,
  FileText,
  HelpCircle,
  Info,
  Mail,
  Presentation,
} from "lucide-react";
import { signOut, useSession } from "@/lib/auth-client";
import { disconnectStreamClients } from "@/providers/StreamProvider";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useCurrency, SUPPORTED_CURRENCIES } from "@/hooks/useCurrency";
import { useAnnouncementBar } from "@/providers/AnnouncementBarProvider";
import familiariseLogoTransparent from "@/public/avif/static/assets/logos/images/logos/Familiarise-logos_transparent.avif";
import familiariseLogoWhite from "@/public/avif/static/assets/logos/images/logos/Familiarise-logos_white.avif";

const defaultUserImage = "/avif/static/assets/default-profile.avif";

// ─── Nav Data ────────────────────────────────────────────────────────────────

interface NavDropdownItem {
  label: string;
  href: string;
  description: string;
  icon: React.ElementType;
  disabled?: boolean;
  comingSoon?: boolean;
}

interface NavCategoryChip {
  label: string;
  href: string;
}

interface NavDropdownGroup {
  label: string;
  items: NavDropdownItem[];
  categoryChips?: NavCategoryChip[];
}

const EXPLORE_ITEMS: NavDropdownItem[] = [
  {
    label: "Find Experts",
    href: "/explore/experts",
    description: "Browse verified consultants across domains",
    icon: Search,
  },
  {
    label: "Browse Programs",
    href: "/explore/programs",
    description: "Webinars, classes, and group sessions",
    icon: Presentation,
  },
  {
    label: "Explore Organisations",
    href: "/explore/enterprise/organisations",
    description: "Discover agencies and expert networks",
    icon: Building2,
  },
];

const EXPLORE_CATEGORIES: NavCategoryChip[] = [
  { label: "Technology", href: "/explore/experts?domain=Technology" },
  { label: "Business", href: "/explore/experts?domain=Business" },
  { label: "Creative Arts", href: "/explore/experts?domain=Creative Arts" },
  { label: "Education", href: "/explore/experts?domain=Education" },
  { label: "Health", href: "/explore/experts?domain=Health" },
  {
    label: "Personal Dev",
    href: "/explore/experts?domain=Personal Development",
  },
];

const USE_CASE_ITEMS: NavDropdownItem[] = [
  {
    label: "For College Students",
    href: "/use-cases/college-students",
    description: "Get career guidance before you graduate",
    icon: GraduationCap,
  },
  {
    label: "For Early-Career Professionals",
    href: "/use-cases/early-career",
    description: "Accelerate your first 1–5 years",
    icon: Briefcase,
  },
  {
    label: "For Career Switchers",
    href: "/use-cases/career-switchers",
    description: "Navigate the service-to-product transition",
    icon: ArrowRightLeft,
  },
  {
    label: "For Long-Term Mentorship",
    href: "/use-cases/mentorship",
    description: "Ongoing guidance from industry experts",
    icon: UserCheck,
  },
];

const BUSINESS_ITEMS: NavDropdownItem[] = [
  {
    label: "Team Training & Corporate Mentorship",
    href: "/contactus",
    description: "Coming soon — contact us to express interest",
    icon: Building2,
    disabled: true,
  },
];

const RESOURCE_ITEMS: NavDropdownItem[] = [
  {
    label: "Community",
    href: "/explore/community",
    description: "Connect with peers and mentors",
    icon: Users,
    comingSoon: true,
  },
  {
    label: "Blog",
    href: "/blog",
    description: "Insights, tips, and career advice",
    icon: FileText,
    comingSoon: true,
  },
  {
    label: "How It Works",
    href: "/#how-it-works",
    description: "See how Familiarise works",
    icon: HelpCircle,
  },
  {
    label: "About",
    href: "/about",
    description: "Our mission and story",
    icon: Info,
  },
  {
    label: "Contact",
    href: "/contactus",
    description: "Get in touch with our team",
    icon: Mail,
  },
];

const NAV_GROUPS: NavDropdownGroup[] = [
  { label: "Use Cases", items: USE_CASE_ITEMS },
  { label: "Explore", items: EXPLORE_ITEMS, categoryChips: EXPLORE_CATEGORIES },
  { label: "For Businesses", items: BUSINESS_ITEMS },
  { label: "Resources", items: RESOURCE_ITEMS },
];

// ─── Dropdown Panel (Desktop) ────────────────────────────────────────────────

function DesktopDropdownPanel({
  group,
  onClose,
}: {
  group: NavDropdownGroup;
  onClose: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.15 }}
      className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-80 bg-popover rounded-xl shadow-xl border border-border overflow-hidden z-[1100]"
    >
      <div className="p-2">
        {group.items.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href + item.label}
              href={item.disabled ? "/contactus" : item.href}
              onClick={onClose}
              className={`flex items-start gap-3 px-3 py-2.5 rounded-lg transition-colors ${
                item.disabled ? "opacity-60 cursor-default" : "hover:bg-muted"
              }`}
            >
              <div className="mt-0.5 w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                <Icon className="w-4 h-4 text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground flex items-center gap-2">
                  {item.label}
                  {(item.disabled || item.comingSoon) && (
                    <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      Soon
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {item.description}
                </p>
              </div>
            </Link>
          );
        })}
      </div>

      {/* Category chips */}
      {group.categoryChips && group.categoryChips.length > 0 && (
        <div className="border-t border-border px-4 py-3">
          <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-2">
            By Category
          </p>
          <div className="flex flex-wrap gap-1.5">
            {group.categoryChips.map((chip) => (
              <Link
                key={chip.href}
                href={chip.href}
                onClick={onClose}
                className="text-xs px-2.5 py-1 rounded-full bg-muted text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                {chip.label}
              </Link>
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
}

// ─── Desktop Nav Item ────────────────────────────────────────────────────────

function DesktopNavItem({
  group,
  showDarkStyle,
}: {
  group: NavDropdownGroup;
  showDarkStyle: boolean;
}) {
  const [open, setOpen] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleEnter = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setOpen(true);
  }, []);

  const handleLeave = useCallback(() => {
    timeoutRef.current = setTimeout(() => setOpen(false), 150);
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <button
        className={`inline-flex items-center gap-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
          showDarkStyle
            ? "text-white hover:bg-white/10"
            : "text-foreground hover:bg-muted"
        }`}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        {group.label}
        <ChevronDown
          className={`w-3.5 h-3.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      <AnimatePresence>
        {open && (
          <DesktopDropdownPanel group={group} onClose={() => setOpen(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Main Navbar ─────────────────────────────────────────────────────────────

type NavbarSession = ReturnType<typeof useSession>["data"];

const Navbar = ({ initialSession }: { initialSession?: NavbarSession }) => {
  const router = useRouter();
  const pathname = usePathname();
  const { data, isPending } = useSession();
  // Seed from the server-fetched session so the first paint shows the correct
  // auth state instead of flashing the signed-out CTA until the client-side
  // /get-session resolves. useSession takes over once it loads.
  const session = isPending ? (data ?? initialSession ?? null) : data;
  const [isOpen, setIsOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const { currency, symbol, setCurrency } = useCurrency();
  const { isVisible: isAnnouncementVisible } = useAnnouncementBar();

  const darkHeroPages = [
    "/",
    "/explore/experts",
    "/explore/programs",
    "/explore/community",
    "/explore/enterprise/organisations",
  ];
  const hasDarkHero = darkHeroPages.includes(pathname);

  const toggleMenu = () => setIsOpen(!isOpen);
  const closeMenu = () => setIsOpen(false);

  useEffect(() => {
    const checkScroll = () => setIsScrolled(window.scrollY > 50);
    window.addEventListener("scroll", checkScroll);
    return () => window.removeEventListener("scroll", checkScroll);
  }, []);

  const handleNavigation = (path: string) => {
    router.push(path);
    closeMenu();
  };

  const excludeNavbar =
    pathname.startsWith("/api/") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/form/") ||
    pathname.startsWith("/checkout/") ||
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname.startsWith("/meetings/");

  if (excludeNavbar) return null;

  const handleSignOut = async () => {
    try {
      await disconnectStreamClients();
    } catch {
      // Don't block sign-out if disconnect fails
    }
    signOut({
      fetchOptions: {
        onSuccess: () => {
          window.location.href = "/auth/signin";
        },
      },
    });
    closeMenu();
  };

  const getUserImage = () => {
    return session?.user?.image && session.user.image !== ""
      ? session.user.image
      : defaultUserImage;
  };

  const showDarkStyle = hasDarkHero && !isScrolled;

  return (
    <>
      {/* Main Navbar */}
      <nav
        className={`fixed w-full z-[1000] transition-all duration-300 ${
          showDarkStyle
            ? "bg-transparent"
            : "bg-background/90 backdrop-blur-xl border-b border-border shadow-sm"
        }`}
        style={{
          top: `calc(var(--maintenance-banner-height, 0px) + ${isAnnouncementVisible ? "var(--announcement-bar-height, 0px)" : "0px"})`,
        }}
      >
        <div className="container mx-auto px-4 md:px-6">
          <div
            className="flex justify-between items-center"
            style={{ height: "var(--navbar-height)" }}
          >
            {/* Logo */}
            <Link href="/" className="flex-shrink-0">
              <div className="relative h-10 md:h-12 w-32 md:w-40">
                <Image
                  src={
                    showDarkStyle
                      ? familiariseLogoWhite
                      : familiariseLogoTransparent
                  }
                  alt="Familiarise Logo"
                  fill
                  className="object-contain object-left"
                  sizes="160px"
                  priority
                />
              </div>
            </Link>

            {/* Desktop Navigation */}
            <div className="hidden lg:flex items-center gap-0.5">
              {session?.user && (
                <Link href="/dashboard">
                  <Button
                    variant="ghost"
                    className={`font-medium ${showDarkStyle ? "text-white hover:bg-white/10" : "text-foreground hover:bg-muted"}`}
                  >
                    Dashboard
                  </Button>
                </Link>
              )}

              {NAV_GROUPS.map((group) => (
                <DesktopNavItem
                  key={group.label}
                  group={group}
                  showDarkStyle={showDarkStyle}
                />
              ))}

              {/* Pricing — flat link */}
              <Link href="/pricing">
                <Button
                  variant="ghost"
                  className={`font-medium ${showDarkStyle ? "text-white hover:bg-white/10" : "text-foreground hover:bg-muted"}`}
                >
                  Pricing
                </Button>
              </Link>
            </div>

            {/* Desktop Auth / CTA Buttons */}
            <div className="hidden lg:flex items-center gap-3">
              {/* Currency Selector */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`gap-1 text-xs font-medium px-2 ${
                      showDarkStyle
                        ? "text-zinc-300 hover:text-white hover:bg-white/10"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    }`}
                  >
                    {symbol} {currency}
                    <ChevronDown className="w-3 h-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[120px]">
                  {SUPPORTED_CURRENCIES.map((c) => (
                    <DropdownMenuItem
                      key={c.code}
                      onClick={() => setCurrency(c.code)}
                      className={
                        currency === c.code ? "bg-accent font-medium" : ""
                      }
                    >
                      {c.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              {session?.user ? (
                <div className="flex items-center gap-3">
                  <Link href="/profile">
                    <Avatar className="h-9 w-9 border-2 border-zinc-200 hover:border-zinc-400 transition-colors cursor-pointer">
                      <AvatarImage src={getUserImage()} alt="Profile" />
                      <AvatarFallback className="bg-zinc-900 text-white text-sm">
                        {session.user.name?.charAt(0) ?? "U"}
                      </AvatarFallback>
                    </Avatar>
                  </Link>
                  <Button
                    variant="ghost"
                    onClick={handleSignOut}
                    className={`text-sm ${showDarkStyle ? "text-zinc-300 hover:text-white hover:bg-white/10" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    Sign out
                  </Button>
                </div>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    onClick={() => handleNavigation("/auth/signin")}
                    className={`font-medium ${showDarkStyle ? "text-white hover:bg-white/10" : "text-foreground hover:bg-muted"}`}
                  >
                    Sign in
                  </Button>
                  <Button
                    onClick={() => handleNavigation("/form/onboarding")}
                    className={
                      showDarkStyle
                        ? "bg-white text-zinc-900 hover:bg-zinc-200"
                        : "bg-primary text-primary-foreground hover:bg-primary/90"
                    }
                  >
                    Become an Expert
                  </Button>
                </>
              )}
            </div>

            {/* Mobile Menu Toggle */}
            <button
              onClick={toggleMenu}
              aria-label="Toggle Navigation"
              className={`lg:hidden p-2 rounded-lg transition-colors ${
                showDarkStyle
                  ? "text-white hover:bg-white/10"
                  : "text-foreground hover:bg-muted"
              }`}
            >
              {isOpen ? (
                <X className="w-6 h-6" />
              ) : (
                <Menu className="w-6 h-6" />
              )}
            </button>
          </div>
        </div>
      </nav>

      {/* Mobile Drawer */}
      <AnimatePresence>
        {isOpen && (
          <>
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[1001] lg:hidden"
              onClick={closeMenu}
            />

            {/* Drawer */}
            <motion.div
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="lg:hidden fixed top-0 left-0 h-full w-[85%] max-w-sm bg-zinc-950 z-[1002] shadow-2xl safe-top safe-bottom safe-left"
            >
              {/* Drawer Header */}
              <div className="flex justify-between items-center p-5 border-b border-zinc-800">
                <div className="relative h-8 w-28">
                  <Image
                    src={familiariseLogoWhite}
                    alt="Familiarise Logo"
                    fill
                    className="object-contain object-left"
                    sizes="112px"
                  />
                </div>
                <button
                  onClick={closeMenu}
                  className="w-9 h-9 flex items-center justify-center rounded-full bg-zinc-800 hover:bg-zinc-700 transition-colors text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Navigation — Accordion Sections */}
              <div
                className="flex flex-col p-5 overflow-y-auto"
                style={{ maxHeight: "calc(100% - 10rem)" }}
              >
                {session?.user && (
                  <Link
                    href="/dashboard"
                    className="flex items-center gap-3 px-4 py-3 rounded-xl text-white hover:bg-zinc-800 transition-colors mb-1"
                    onClick={closeMenu}
                  >
                    <span className="font-medium">Dashboard</span>
                  </Link>
                )}

                <Accordion type="multiple" className="w-full">
                  {NAV_GROUPS.map((group) => (
                    <AccordionItem
                      key={group.label}
                      value={group.label}
                      className="border-b border-zinc-800"
                    >
                      <AccordionTrigger className="text-white hover:no-underline px-4 py-3">
                        {group.label}
                      </AccordionTrigger>
                      <AccordionContent className="px-2 pb-2">
                        <div className="space-y-1">
                          {group.items.map((item) => (
                            <Link
                              key={item.href + item.label}
                              href={item.disabled ? "/contactus" : item.href}
                              onClick={closeMenu}
                              className={`block px-4 py-2.5 rounded-lg transition-colors ${
                                item.disabled
                                  ? "opacity-50"
                                  : "hover:bg-zinc-800"
                              }`}
                            >
                              <span className="text-sm font-medium text-white flex items-center gap-2">
                                {item.label}
                                {(item.disabled || item.comingSoon) && (
                                  <span className="text-[10px] uppercase tracking-wider text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">
                                    Soon
                                  </span>
                                )}
                              </span>
                              <span className="text-xs text-zinc-500 mt-0.5 block">
                                {item.description}
                              </span>
                            </Link>
                          ))}

                          {/* Category chips on mobile */}
                          {group.categoryChips &&
                            group.categoryChips.length > 0 && (
                              <div className="px-4 pt-2">
                                <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500 mb-2">
                                  By Category
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                  {group.categoryChips.map((chip) => (
                                    <Link
                                      key={chip.href}
                                      href={chip.href}
                                      onClick={closeMenu}
                                      className="text-xs px-2.5 py-1 rounded-full bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-white transition-colors"
                                    >
                                      {chip.label}
                                    </Link>
                                  ))}
                                </div>
                              </div>
                            )}
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>

                {/* Pricing — flat link */}
                <Link
                  href="/pricing"
                  className="flex items-center gap-3 px-4 py-3 rounded-xl text-white hover:bg-zinc-800 transition-colors mt-1"
                  onClick={closeMenu}
                >
                  <span className="font-medium">Pricing</span>
                </Link>

                {/* Mobile Currency Selector */}
                <div className="px-4 pt-4 mt-2 border-t border-zinc-800">
                  <span className="text-xs text-zinc-500 uppercase tracking-wide">
                    Currency
                  </span>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {SUPPORTED_CURRENCIES.map((c) => (
                      <button
                        key={c.code}
                        onClick={() => setCurrency(c.code)}
                        className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                          currency === c.code
                            ? "bg-white text-zinc-900 font-medium"
                            : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                        }`}
                      >
                        {c.symbol} {c.code}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* User Section */}
              <div className="absolute bottom-0 left-0 right-0 p-5 border-t border-zinc-800 bg-zinc-900 safe-bottom">
                {session?.user ? (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-10 w-10 border border-zinc-700">
                        <AvatarImage src={getUserImage()} alt="Profile" />
                        <AvatarFallback className="bg-zinc-800 text-white">
                          {session.user.name?.charAt(0) ?? "U"}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-white font-medium text-sm truncate max-w-[140px]">
                        {session.user.name}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      onClick={handleSignOut}
                      className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                    >
                      Sign out
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    <Button
                      onClick={() => handleNavigation("/form/onboarding")}
                      className="w-full bg-white text-zinc-900 hover:bg-zinc-200"
                    >
                      Become an Expert
                    </Button>
                    <Button
                      onClick={() => handleNavigation("/auth/signin")}
                      className="w-full bg-transparent border border-zinc-700 text-white hover:bg-zinc-800"
                    >
                      Sign in
                    </Button>
                  </div>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
};

export default Navbar;
