"use client";

import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, Menu, X } from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useCurrency,
  SUPPORTED_CURRENCIES,
} from "@/lib/hooks/useCurrency";
import { useAnnouncementBar } from "@/providers/AnnouncementBarProvider";
import familiariseLogoTransparent from "@/public/avif/static/assets/logos/images/logos/Familiarise-logos_transparent.avif";
import familiariseLogoWhite from "@/public/avif/static/assets/logos/images/logos/Familiarise-logos_white.avif";

const defaultUserImage = "/avif/static/assets/default-profile.avif";

const Navbar = () => {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session } = useSession();
  const [isOpen, setIsOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const { currency, symbol, setCurrency } = useCurrency();
  const { isVisible: isAnnouncementVisible } = useAnnouncementBar();

  // Check if we're on a page with dark hero (for transparent navbar)
  const darkHeroPages = [
    "/",
    "/explore/experts",
    "/explore/programs",
    "/explore/community",
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

  // Check if the current route should exclude navbar
  const excludeNavbar =
    pathname.startsWith("/api/") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/form/") ||
    pathname.startsWith("/checkout/") ||
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname.startsWith("/meetings/");

  if (excludeNavbar) return null;

  // Navigation links
  const navLinks = [
    { path: "/explore/experts", label: "Experts" },
    { path: "/explore/programs", label: "Programs" },
    { path: "/explore/community", label: "Community" },
    { path: "/blog", label: "Blog" },
  ];

  const handleSignOut = () => {
    signOut();
    closeMenu();
  };

  const getUserImage = () => {
    return session?.user?.image && session.user.image !== ""
      ? session.user.image
      : defaultUserImage;
  };

  // Determine navbar style based on scroll and page
  const showDarkStyle = hasDarkHero && !isScrolled;

  return (
    <>
      {/* Main Navbar */}
      <nav
        className={`fixed w-full z-[1000] transition-all duration-300 ${
          showDarkStyle
            ? "bg-transparent"
            : "bg-white/90 backdrop-blur-xl border-b border-zinc-200 shadow-sm"
        }`}
        style={{
          top: isAnnouncementVisible
            ? "var(--announcement-bar-height, 0px)"
            : "0px",
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
            <div className="hidden lg:flex items-center gap-1">
              {session?.user && (
                <Link href="/dashboard">
                  <Button
                    variant="ghost"
                    className={`font-medium ${showDarkStyle ? "text-white hover:bg-white/10" : "text-zinc-700 hover:bg-zinc-100"}`}
                  >
                    Dashboard
                  </Button>
                </Link>
              )}
              {navLinks.map((link) => (
                <Link key={link.path} href={link.path}>
                  <Button
                    variant="ghost"
                    className={`font-medium ${showDarkStyle ? "text-white hover:bg-white/10" : "text-zinc-700 hover:bg-zinc-100"}`}
                  >
                    {link.label}
                  </Button>
                </Link>
              ))}
            </div>

            {/* Desktop Auth Buttons */}
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
                        : "text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100"
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
                        currency === c.code ? "bg-zinc-100 font-medium" : ""
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
                    className={`text-sm ${showDarkStyle ? "text-zinc-300 hover:text-white hover:bg-white/10" : "text-zinc-600 hover:text-zinc-900"}`}
                  >
                    Sign out
                  </Button>
                </div>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    onClick={() => handleNavigation("/auth/signup")}
                    className={`font-medium ${showDarkStyle ? "text-white hover:bg-white/10" : "text-zinc-700 hover:bg-zinc-100"}`}
                  >
                    Sign up
                  </Button>
                  <Button
                    onClick={() => handleNavigation("/auth/signin")}
                    className={
                      showDarkStyle
                        ? "bg-white text-zinc-900 hover:bg-zinc-200"
                        : "bg-zinc-900 text-white hover:bg-zinc-800"
                    }
                  >
                    Sign in
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
                  : "text-zinc-700 hover:bg-zinc-100"
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

              {/* Navigation Links */}
              <div className="flex flex-col p-5 space-y-1 overflow-y-auto" style={{ maxHeight: "calc(100% - 10rem)" }}>
                {session?.user && (
                  <Link
                    href="/dashboard"
                    className="flex items-center gap-3 px-4 py-3 rounded-xl text-white hover:bg-zinc-800 transition-colors"
                    onClick={closeMenu}
                  >
                    <span className="text-zinc-400">🎯</span>
                    <span className="font-medium">Dashboard</span>
                  </Link>
                )}
                {navLinks.map((link) => (
                  <Link
                    key={link.path}
                    href={link.path}
                    className="flex items-center gap-3 px-4 py-3 rounded-xl text-white hover:bg-zinc-800 transition-colors"
                    onClick={closeMenu}
                  >
                    <span className="font-medium">{link.label}</span>
                  </Link>
                ))}

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
                      onClick={() => handleNavigation("/auth/signin")}
                      className="w-full bg-white text-zinc-900 hover:bg-zinc-200"
                    >
                      Sign in
                    </Button>
                    <Button
                      onClick={() => handleNavigation("/auth/signup")}
                      className="w-full bg-transparent border border-zinc-700 text-white hover:bg-zinc-800"
                    >
                      Sign up
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
