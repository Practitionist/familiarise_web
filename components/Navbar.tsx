"use client";
import { motion } from "framer-motion";

import { signOut, useSession } from "next-auth/react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import familiariseLogoTransparent from "@/public/avif/static/assets/logos/images/logos/Familiarise-logos_transparent.avif";
// Using public path for Next.js static asset
const defaultUserImage = "/avif/static/assets/default-profile.avif";

const Navbar = () => {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session } = useSession();
  const [isOpen, setIsOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [isAnnouncementVisible, setIsAnnouncementVisible] = useState(true);

  useEffect(() => {
    const checkAnnouncementState = () => {
      const isClosed = localStorage.getItem("announcementBarClosed") === "true";
      setIsAnnouncementVisible(!isClosed);
    };

    // Check initial state
    checkAnnouncementState();

    // Listen for storage changes
    window.addEventListener("storage", checkAnnouncementState);
    return () => window.removeEventListener("storage", checkAnnouncementState);
  }, []);

  const toggleMenu = () => {
    setIsOpen(!isOpen);
  };

  const closeMenu = () => {
    setIsOpen(false);
  };

  useEffect(() => {
    const checkScroll = () => {
      setIsScrolled(window.scrollY > 50);
    };

    window.addEventListener("scroll", checkScroll);

    // Cleanup after the effect:
    return () => {
      window.removeEventListener("scroll", checkScroll);
    };
  }, []); // Empty dependency array ensures this runs once on mount and unmount

  const handleNavigation = (path: string) => {
    try {
      router.push(path);
      closeMenu();
    } catch (e) {
      console.log(e);
    }
  };

  // Check if the current route should exclude navbar
  const excludeNavbar =
    pathname.startsWith("/api/") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/form/") ||
    pathname.startsWith("/checkout/") ||
    pathname.startsWith("/dashboard/") ||
    pathname.startsWith("/meetings/");

  if (excludeNavbar) return null;

  // Navigation links data
  const navLinks = [
    { path: "/explore/experts", label: "Experts", icon: "👨‍🏫" },
    {
      path: "/explore/programs",
      label: "Programs",
      icon: "🎥",
    },
    { path: "/explore/community", label: "Community", icon: "👥" },
    { path: "/blog", label: "Blog", icon: "📝" },
  ];

  // Handle sign out
  const handleSignOut = () => {
    signOut();
    closeMenu();
  };

  // Get user image with fallback
  const getUserImage = () => {
    return session?.user?.image && session.user.image !== ""
      ? session.user.image
      : defaultUserImage;
  };

  // Render user section (profile or sign in/up buttons)
  const renderUserSection = (isMobile = false) => {
    if (session?.user) {
      return isMobile ? (
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <Image
              src={getUserImage()}
              alt="Profile"
              width={40}
              height={40}
              className="rounded-full"
            />
            <span className="text-sm font-medium">{session.user.name}</span>
          </div>
          <button
            onClick={handleSignOut}
            className="px-4 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
          >
            Sign out
          </button>
        </div>
      ) : (
        <>
          <Link href="/profile">
            <Image
              src={getUserImage()}
              alt="Profile"
              width={50}
              height={50}
              className="rounded-full cursor-pointer"
            />
          </Link>
          <button onClick={() => signOut()} className="ml-2">
            Sign out
          </button>
        </>
      );
    }

    return isMobile ? (
      <div className="flex flex-col space-y-2">
        <button
          onClick={() => handleNavigation("/auth/signin")}
          className="w-full py-2 bg-white text-black rounded-lg hover:bg-gray-100 transition-colors font-medium"
        >
          Sign in
        </button>
        <button
          onClick={() => handleNavigation("/auth/signup")}
          className="w-full py-2 border border-gray-600 text-white rounded-lg hover:bg-gray-800 transition-colors font-medium"
        >
          Sign up
        </button>
      </div>
    ) : (
      <>
        <button
          className="mr-2 border border-gray-600 text-white rounded-lg px-4 py-2 hover:bg-gray-800 transition-colors font-medium"
          onClick={() => handleNavigation("/auth/signup")}
        >
          Sign up
        </button>
        <button
          className="mr-2 bg-white text-black border border-white rounded-lg px-4 py-2 hover:bg-gray-100 transition-colors font-medium"
          onClick={() => handleNavigation("/auth/signin")}
        >
          Sign in
        </button>
      </>
    );
  };

  return (
    <>
      {/* Main Navbar */}
      <nav
        className={`fixed w-full z-[1000] py-2 px-6 lg:px-0 transition-all duration-300 backdrop-blur-xl bg-black/80 border-b border-gray-800 ${
          isAnnouncementVisible ? "top-[42px]" : "top-0"
        } ${isScrolled ? "shadow-lg shadow-gray-900/50" : ""}`}
      >
        <div className="flex justify-between items-center">
          <Link href="/">
            <div
              className="relative h-[60px] w-auto"
              style={{ minWidth: 120, maxWidth: 320 }}
            >
              <Image
                src={familiariseLogoTransparent}
                alt="Familiarise Logo"
                fill
                className="object-contain"
                sizes="(max-width: 320px) 100vw, 320px"
              />
            </div>
          </Link>
          <div className="lg:hidden">
            <button
              onClick={toggleMenu}
              aria-label="Toggle Navigation"
              className="text-2xl text-white hover:text-teal-400 transition-colors"
            >
              ☰
            </button>
          </div>

          <div className="hidden lg:flex gap-8">
            {session?.user && (
              <Link href="/dashboard">
                <button className="text-white hover:text-teal-400 transition-colors font-medium">
                  Dashboard
                </button>
              </Link>
            )}
            {navLinks.map((link) => (
              <Link key={link.path} href={link.path}>
                <button className="text-white hover:text-teal-400 transition-colors font-medium">
                  {link.label}
                </button>
              </Link>
            ))}
          </div>

          <div className="flex items-center hidden lg:flex">
            {renderUserSection()}
          </div>
        </div>
      </nav>

      {/* Side Drawer */}
      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black bg-opacity-50 z-40"
            onClick={closeMenu}
          />

          {/* Drawer */}
          <motion.div
            className="lg:hidden fixed top-0 left-0 h-full w-4/5 max-w-md bg-gradient-to-br from-gray-900 via-gray-950 to-black backdrop-blur-lg z-50 shadow-2xl border-r border-gray-800"
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={{ type: "spring", duration: 1 }}
          >
            {/* Header */}
            <div className="flex justify-between items-center p-6 border-b border-gray-800">
              <div
                className="relative h-[40px] w-auto"
                style={{ minWidth: 80, maxWidth: 200 }}
              >
                <Image
                  src={familiariseLogoTransparent}
                  alt="Familiarise Logo"
                  fill
                  className="object-contain"
                  sizes="(max-width: 200px) 100vw, 200px"
                />
              </div>
              <button
                onClick={closeMenu}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-800 hover:bg-gray-700 transition-colors"
              >
                <span className="text-xl text-white">&times;</span>
              </button>
            </div>

            {/* Navigation Links */}
            <div className="flex flex-col p-6 space-y-4">
              {session?.user && (
                <Link
                  href="/dashboard"
                  className="flex items-center space-x-2 px-4 py-2 rounded-lg hover:bg-gray-800 transition-colors text-white"
                  onClick={closeMenu}
                >
                  <span>🎯</span>
                  <span>Dashboard</span>
                </Link>
              )}
              {navLinks.map((link) => (
                <Link
                  key={link.path}
                  href={link.path}
                  className="flex items-center space-x-2 px-4 py-2 rounded-lg hover:bg-gray-800 transition-colors text-white"
                  onClick={closeMenu}
                >
                  <span>{link.icon}</span>
                  <span>{link.label}</span>
                </Link>
              ))}
            </div>

            {/* User Section */}
            <div className="absolute bottom-0 left-0 right-0 p-6 border-t border-gray-800">
              {renderUserSection(true)}
            </div>
          </motion.div>
        </>
      )}
    </>
  );
};

export default Navbar;
