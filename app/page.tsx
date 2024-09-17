"use client";

import { Provider as ReduxProvider } from "react-redux";
import { AnimatePresence } from "framer-motion";

import { Faq } from "@/components/home/faq";
import { Newsletter } from "@/components/home/newsletter";
import TestimonialsSection from "@/components/home/testimonials";
import MeetTheTeam from "@/components/home/MeetTheTeam";
import HeroSection from "@/components/home/HeroSection";
import TransformCareerSection from "@/components/home/TransformCareerSection";
import UnlockPotentialSection from "@/components/home/UnlockPotentialSection";
import BestExpertsSection from "@/components/home/BestExpertsSection";
import FeaturedExpertsSection from "@/components/home/FeaturedExpertsSection";
import OfferingsSection from "@/components/home/OfferingsSection";
import JoinCommunitySection from "@/components/home/JoinCommunitySection";

import store from "@/redux/store";
import { useImages } from "@/hooks/useImages";

export default function Home() {
  const images = useImages("consultx_bucket", "assets/images");

  return (
    <ReduxProvider store={store}>
      <AnimatePresence>
        <main className="flex-0">
          <HeroSection images={images} />
          <TransformCareerSection images={images} />
          <UnlockPotentialSection images={images} />
          <BestExpertsSection images={images} />
          <FeaturedExpertsSection />
          <OfferingsSection />
          <JoinCommunitySection />
          <Faq />
          <TestimonialsSection />
          <MeetTheTeam />
          <Newsletter />
        </main>
      </AnimatePresence>
    </ReduxProvider>
  );
}
