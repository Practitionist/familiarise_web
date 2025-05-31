"use client";
import { motion } from "framer-motion";
import micromatch from "micromatch";
import { signOut, useSession } from "next-auth/react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import familiariselogo from "../public/avif/static/assets/logos/images/logos/Familiarise-logos_transparent.avif";
import defaultUserImage from "../public/avif/static/assets/default-profile.avif";

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
  const apiRoutes = ["/api/**"];
  const publicAuthRoutes = ["/auth/**"];
  const formRoutes = ["/form/**"];
  const checkoutRoutes = ["/checkout/**"];
  const dashboardRoutes = ["/dashboard/**"];
  const meetingRoutes = ["/meetings/**"];
  const excludeNavbar =
    micromatch.isMatch(pathname, apiRoutes) ||
    micromatch.isMatch(pathname, publicAuthRoutes) ||
    micromatch.isMatch(pathname, formRoutes) ||
    micromatch.isMatch(pathname, checkoutRoutes) ||
    micromatch.isMatch(pathname, dashboardRoutes) ||
    micromatch.isMatch(pathname, meetingRoutes);
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
          className="w-full py-2 bg-black text-white rounded-lg hover:bg-gray-800 transition-colors"
        >
          Sign in
        </button>
        <button
          onClick={() => handleNavigation("/auth/signup")}
          className="w-full py-2 border border-black rounded-lg hover:bg-gray-50 transition-colors"
        >
          Sign up
        </button>
      </div>
    ) : (
      <>
        <button
          className="mr-2 border border-black rounded px-2 py-1"
          onClick={() => handleNavigation("/auth/signup")}
        >
          Sign up
        </button>
        <button
          className="mr-2 bg-black text-white border border-black rounded px-2 py-1"
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
        className={`fixed w-full z-[1000] py-2 px-6 lg:px-0 transition-all duration-300 backdrop-blur-xl bg-white/40 ${
          isAnnouncementVisible ? "top-[42px]" : "top-0"
        } ${isScrolled ? "shadow-md" : ""}`}
      >
        <div className="flex justify-between items-center">
          <Link href="/">
            <Image src={familiariselogo} alt="Familiarise Logo" height={60} />
          </Link>
          <div className="lg:hidden">
            <button
              onClick={toggleMenu}
              aria-label="Toggle Navigation"
              className="text-2xl hover:text-gray-600 transition-colors"
            >
              ☰
            </button>
          </div>

          <div className="hidden lg:flex gap-8">
            {session?.user && (
              <Link href="/dashboard">
                <button>Dashboard</button>
              </Link>
            )}
            {navLinks.map((link) => (
              <Link key={link.path} href={link.path}>
                <button>{link.label}</button>
              </Link>
            ))}
          </div>

          <div className="flex items-center">{renderUserSection()}</div>
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
            className="lg:hidden fixed top-0 left-0 h-full w-4/5 max-w-md bg-gradient-to-br from-white via-white to-gray-50 backdrop-blur-lg z-50 shadow-2xl"
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={{ type: "spring", duration: 1 }}
          >
            {/* Header */}
            <div className="flex justify-between items-center p-6 border-b border-gray-100">
              <Image src={familiariselogo} alt="Familiarise Logo" height={40} />
              <button
                onClick={closeMenu}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 hover:bg-gray-200 transition-colors"
              >
                <span className="text-xl">&times;</span>
              </button>
            </div>

            {/* Navigation Links */}
            <div className="flex flex-col p-6 space-y-4">
              {session?.user && (
                <Link
                  href="/dashboard"
                  className="flex items-center space-x-2 px-4 py-2 rounded-lg hover:bg-gray-100 transition-colors"
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
                  className="flex items-center space-x-2 px-4 py-2 rounded-lg hover:bg-gray-100 transition-colors"
                  onClick={closeMenu}
                >
                  <span>{link.icon}</span>
                  <span>{link.label}</span>
                </Link>
              ))}
            </div>

            {/* User Section */}
            <div className="absolute bottom-0 left-0 right-0 p-6 border-t border-gray-100">
              {renderUserSection(true)}
            </div>
          </motion.div>
        </>
      )}
    </>
  );
};

export default Navbar;
