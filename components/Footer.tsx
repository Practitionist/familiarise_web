"use client";
import React from "react";
import Image from "next/image";
import {
  FaFacebook,
  FaInstagram,
  FaYoutube,
  FaLinkedin,
  FaTwitter,
} from "react-icons/fa";
import familiariseLogoWhite from "@/public/avif/static/assets/logos/images/logos/Familiarise-logos_white.avif";
import Link from "next/link";
import { usePathname } from "next/navigation";

const Footer: React.FC = () => {
  const pathname = usePathname();

  // Routes where footer should be hidden
  const excludeFooter =
    pathname.startsWith("/api/") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/form/") ||
    pathname.startsWith("/checkout/") ||
    pathname.startsWith("/dashboard/") ||
    pathname.startsWith("/meetings/");

  if (excludeFooter) return null;

  return (
    <footer className="flex flex-col items-center justify-center p-5 bg-black text-white mt-auto">
      <div className="w-full flex justify-center pb-5">
        {/* Responsive company logo using fill */}
        <div
          className="relative h-[60px] w-auto"
          style={{ minWidth: 120, maxWidth: 320 }}
        >
          <Image
            src={familiariseLogoWhite}
            alt="Company Logo"
            fill
            className="object-contain"
            sizes="(max-width: 320px) 100vw, 320px"
          />
        </div>
      </div>
      <div className="flex justify-between w-full max-w-6xl">
        <div className="flex flex-col w-1/5">
          <h2 className="mb-2 text-lg font-bold">Explore Areas of Expertise</h2>
          <ul className="list-none p-0 mb-5 space-y-1">
            <li>Doctors</li>
            <li>Lawyers</li>
            <li>Engineers</li>
            <li>Designers</li>
            <li>Higher Education</li>
          </ul>
          <h2 className="mb-2 text-lg font-bold">Follow Us</h2>
          <ul className="list-none p-0 flex space-x-2">
            <li>
              <FaFacebook />
            </li>
            <li>
              <FaInstagram />
            </li>
            <li>
              <FaYoutube />
            </li>
            <li>
              <FaLinkedin />
            </li>
            <li>
              <FaTwitter />
            </li>
          </ul>
        </div>
        <div className="flex flex-col w-1/5">
          <h2 className="mb-2 text-lg font-bold">Overview</h2>
          <ul className="list-none p-0 mb-5 space-y-1">
            <li>
              <Link href="/about" className="hover:underline">
                About
              </Link>
            </li>
            <li>Career</li>
            <li>Press</li>
            <li>
              <Link href="/contactus" className="hover:underline">
                Contact
              </Link>
            </li>
            <li>
              <Link href="/pricing" className="hover:underline">
                Pricing
              </Link>
            </li>
            <li>
              <Link href="/terms" className="hover:underline">
                Terms of Service
              </Link>
            </li>
            <li>
              <Link href="/privacy" className="hover:underline">
                Privacy Policy
              </Link>
            </li>
            <li>
              <Link href="/refund" className="hover:underline">
                Refund Policy
              </Link>
            </li>
            <li>Global Sitemap</li>
            <li>Local Sitemap</li>
          </ul>
        </div>
        <div className="flex flex-col w-1/5">
          <h2 className="mb-2 text-lg font-bold">Community</h2>
          <ul className="list-none p-0 mb-5 space-y-1">
            <li>Community Central</li>
            <li>Support</li>
            <li>Help</li>
            <li>Do not Sell my info</li>
          </ul>
          <h2 className="mb-2 text-lg font-bold">Advertise</h2>
          <ul className="list-none p-0 mb-5 space-y-1">
            <li>Media kit</li>
            <li>Contact</li>
          </ul>
        </div>
        <div className="flex flex-col w-1/5">
          <h2 className="mb-2 text-lg font-bold">Familiarise Apps</h2>
          <p>Stay in touch with us over other platforms</p>
          <h2 className="mb-2 text-lg font-bold">Mobile App</h2>
          <div className="grid grid-cols-3 gap-4">
            {/* Replace with your app logo */}
            {/* Replace with your app store logos */}
          </div>
          <h2 className="mb-2 text-lg font-bold">Familiarise Udemy Channel</h2>
          {/* Replace with your Udemy logo */}
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row py-6 w-full shrink-0 items-center px-4 md:px-6 border-t">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          © Familiarise. All rights reserved.
        </p>
        <nav className="sm:ml-auto flex gap-4 sm:gap-6">
          <Link className="text-xs hover:underline underline-offset-4" href="/terms">
            Terms of Service
          </Link>
          <Link className="text-xs hover:underline underline-offset-4" href="/privacy">
            Privacy
          </Link>
          <Link className="text-xs hover:underline underline-offset-4" href="/refund">
            Refund Policy
          </Link>
        </nav>
      </div>
    </footer>
  );
};

export default Footer;
