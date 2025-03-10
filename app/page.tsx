"use client";

import { AnimatePresence } from "framer-motion";
import { Provider as ReduxProvider } from "react-redux";

import BestExpertsSection from "@/components/home/BestExpertsSection";
import { Faq } from "@/components/home/Faq";
import FeaturedExpertsSection from "@/components/home/FeaturedExpertsSection";
import HeroSection from "@/components/home/HeroSection";
import JoinCommunitySection from "@/components/home/JoinCommunitySection";
import { Newsletter } from "@/components/home/Newsletter";
import OfferingsSection from "@/components/home/OfferingsSection";
import TestimonialsSection from "@/components/home/Testimonials";
import TransformCareerSection from "@/components/home/TransformCareerSection";
import UnlockPotentialSection from "@/components/home/UnlockPotentialSection";

import HowProcessWorksSection from "@/components/home/HowProcessWorksSection";
import { useImages } from "@/hooks/useImages";
import store from "@/redux/store";

export default function Home() {
  const images = useImages("assets", "images/landing-page");

  return (
    <ReduxProvider store={store}>
      <AnimatePresence>
        <main className="flex-1 w-full">
          <HeroSection images={images} />
          <TransformCareerSection images={images} />
          <UnlockPotentialSection images={images} />
          <BestExpertsSection images={images} />
          <FeaturedExpertsSection />
          <OfferingsSection />
          <TestimonialsSection />
          <HowProcessWorksSection />
          <JoinCommunitySection />
          <Faq />
          <Newsletter />
        </main>
      </AnimatePresence>
    </ReduxProvider>
  );
}
