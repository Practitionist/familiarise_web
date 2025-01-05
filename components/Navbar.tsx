"use client";
import { motion } from "framer-motion";
import micromatch from "micromatch";
import { signOut, useSession } from "next-auth/react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import consultxlogo from "../public/static/assets/logos/ConsultX-logos/ConsultX-logos_transparent.png";
import { Button } from "./ui/button";

const Navbar = () => {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session } = useSession();
  const [isOpen, setIsOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [isAnnouncementBarOpen, setIsAnnouncementBarOpen] = useState(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("announcementBarOpen");
      return stored === null ? true : stored === "true";
    }
    return true;
  });

  const toggleMenu = () => {
    setIsOpen(!isOpen);
  };

  const closeMenu = () => {
    setIsOpen(false);
  };

  const handleClose = () => {
    setIsAnnouncementBarOpen(false);
    localStorage.setItem("announcementBarOpen", "false");
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

  const apiRoutes = ["/api/**"];
  const publicAuthRoutes = ["/auth/**"];
  const formRoutes = ["/form/**"];
  const checkoutRoutes = ["/checkout/**"];
  const dashboardRoutes = ["/dashboard/**"];
  const excludeNavbar =
    micromatch.isMatch(pathname, apiRoutes) ||
    micromatch.isMatch(pathname, publicAuthRoutes) ||
    micromatch.isMatch(pathname, formRoutes) ||
    micromatch.isMatch(pathname, checkoutRoutes) ||
    micromatch.isMatch(pathname, dashboardRoutes);
  if (excludeNavbar) return null;

  return (
    <>
      {isAnnouncementBarOpen && (
        <div className="w-full bg-black text-white text-center py-2.5 fixed top-0 z-[1001] flex justify-center">
          🔥 Exciting sale coming soon! Get ready for amazing discounts on
          consultancy sessions! 🔥
          <Button
            style={{ color: "white", marginRight: "10px" }}
            onClick={handleClose}
          >
            X
          </Button>
        </div>
      )}

      {/* Main Navbar */}
      <nav
        className={`fixed w-full z-[1000] py-2 bg-white px-6 lg:px-0 ${
          isAnnouncementBarOpen ? "top-[42px]" : "top-0"
        } ${isScrolled ? "shadow-md" : ""}`}
      >
        <div className="flex justify-between items-center">
          <Link href="/">
            <Image src={consultxlogo} alt="ConsultX Logo" height={60} />
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
            {/* {session?.user && (
              <Link href="/feed">
                <button>Feed</button>
              </Link>
            )} */}
            <Link href="/explore/experts">
              <button>Experts</button>
            </Link>
            <Link href="/explore/programs">
              <button>Programs</button>
            </Link>
            <Link href="/explore/community">
              <button>Community</button>
            </Link>
            <Link href="/blog">
              <button>Blog</button>
            </Link>
          </div>

          <div className="flex items-center">
            {session?.user ? (
              <>
                <Link href="/profile">
                  <Image
                    src={session.user.image!}
                    alt="Profile"
                    width={50}
                    height={50}
                    className="rounded-full cursor-pointer"
                  />
                </Link>
                <button
                  onClick={() => {
                    signOut();
                  }}
                  className="ml-2"
                >
                  Sign out
                </button>
              </>
            ) : (
              <>
                <button
                  className="mr-2 border border-black rounded px-2 py-1"
                  onClick={() => {
                    try {
                      // TODO: Redirect to the sign up page
                      router.push("/auth/signin");
                    } catch (e) {
                      console.log(e);
                    }
                  }}
                >
                  Sign up
                </button>
                <button
                  className="mr-2 bg-black text-white border border-black rounded px-2 py-1"
                  onClick={() => {
                    try {
                      router.push("/auth/signin");
                    } catch (e) {
                      console.log(e);
                    }
                  }}
                >
                  Sign in
                </button>
              </>
            )}
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
            className="lg:hidden fixed top-0 left-0 h-full w-4/5 max-w-md bg-gradient-to-br from-white via-white to-gray-50 backdrop-blur-lg z-50 shadow-2xl"
            initial={{ x: "-100%" }}
            animate={{ x: 0 }}
            exit={{ x: "-100%" }}
            transition={{ type: "spring", duration: 1 }}
          >
            {/* Header */}
            <div className="flex justify-between items-center p-6 border-b border-gray-100">
              <Image src={consultxlogo} alt="ConsultX Logo" height={40} />
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
              <Link
                href="/explore/experts"
                className="flex items-center space-x-2 px-4 py-2 rounded-lg hover:bg-gray-100 transition-colors"
                onClick={closeMenu}
              >
                <span>👨‍🏫</span>
                <span>Experts</span>
              </Link>
              <Link
                href="/explore/webinar"
                className="flex items-center space-x-2 px-4 py-2 rounded-lg hover:bg-gray-100 transition-colors"
                onClick={closeMenu}
              >
                <span>🎥</span>
                <span>Webinar</span>
              </Link>
              <Link
                href="/explore/events"
                className="flex items-center space-x-2 px-4 py-2 rounded-lg hover:bg-gray-100 transition-colors"
                onClick={closeMenu}
              >
                <span>📅</span>
                <span>Events</span>
              </Link>
              <Link
                href="/explore/community"
                className="flex items-center space-x-2 px-4 py-2 rounded-lg hover:bg-gray-100 transition-colors"
                onClick={closeMenu}
              >
                <span>👥</span>
                <span>Community</span>
              </Link>
              <Link
                href="/blog"
                className="flex items-center space-x-2 px-4 py-2 rounded-lg hover:bg-gray-100 transition-colors"
                onClick={closeMenu}
              >
                <span>📝</span>
                <span>Blog</span>
              </Link>
            </div>

            {/* Footer */}
            <div className="absolute bottom-0 left-0 right-0 p-6 border-t border-gray-100">
              {session?.user ? (
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <Image
                      src={session.user.image!}
                      alt="Profile"
                      width={40}
                      height={40}
                      className="rounded-full"
                    />
                    <span className="text-sm font-medium">
                      {session.user.name}
                    </span>
                  </div>
                  <button
                    onClick={() => {
                      signOut();
                      closeMenu();
                    }}
                    className="px-4 py-2 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    Sign out
                  </button>
                </div>
              ) : (
                <div className="flex flex-col space-y-2">
                  <button
                    onClick={() => {
                      router.push("/auth/signin");
                      closeMenu();
                    }}
                    className="w-full py-2 bg-black text-white rounded-lg hover:bg-gray-800 transition-colors"
                  >
                    Sign in
                  </button>
                  <button
                    onClick={() => {
                      router.push("/auth/signin");
                      closeMenu();
                    }}
                    className="w-full py-2 border border-black rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    Sign up
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </>
  );
};

export default Navbar;
