"use client";

import { Faq } from "@/components/faq";
import { Newsletter } from "@/components/newsletter";
import TestimonialsSection from "@/components/testimonials";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import renderImage from "@/lib/image";
import { fetchImagesFromSupabaseStorage } from "@/lib/supabase";
import store from "@/redux/store";
import { AnimatePresence } from "framer-motion";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Provider as ReduxProvider } from "react-redux";
import bannerImage from "../public/static/assets/images/main-banner.jpeg";

type TImage = {
  url: string;
  name: string;
  bucket_id: string;
  owner: string;
  id: string;
  updated_at: string;
  created_at: string;
  last_accessed_at: string;
  metadata: Record<string, any>;
};
export default function Home() {
  const [images, setImages] = useState<TImage[]>([]);

  useEffect(() => {
    const getImages = async () => {
      const fetchedImages = await fetchImagesFromSupabaseStorage(
        "consultx_bucket",
        "assets/images"
      );
      setImages(fetchedImages);
      console.log("Fetched images:", fetchedImages);
    };

    getImages();
  }, []);

  return (
    <ReduxProvider store={store}>
      <AnimatePresence>
        <main className="flex-0">
          <section
            className="h-screen py-12 md:py-24 lg:py-32 xl:py-40 bg-gray-100 flex items-center"
            style={{
              backgroundImage: `url(${renderImage(images, 0, bannerImage.src, 1920, 1080).props.src})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              backgroundPositionY: "15%",
            }}
          >
            <div className="container mx-auto px-4 md:px-6">
              <div className="flex flex-col items-center space-y-6 text-center">
                <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tighter text-gray-900">
                Elevate Your Career with ConsultX
                </h1>
                <p className="max-w-[700px] text-xl md:text-2xl text-gray-800 italic">
                  <q>
                    A platform where experts share their advice through 1-1
                    sessions, classes, webinars, and conferences.
                  </q>
                </p>
                <div className="flex space-x-4">
                  <Link
                    className="inline-flex h-12 items-center justify-center rounded-md bg-gray-900 px-6 py-3 text-sm font-medium text-white shadow transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950"
                    href="#"
                  >
                    Book an Expert Session
                  </Link>
                  <Link
                    className="inline-flex h-12 items-center justify-center rounded-md border border-gray-900 bg-transparent px-6 py-3 text-sm font-medium text-gray-900 shadow transition-colors hover:bg-gray-900 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950"
                    href="#"
                  >
                    Learn More
                  </Link>
                </div>
              </div>
            </div>
          </section>

          <section className="w-full py-16 md:py-24 lg:py-32">
            <div className="container mx-auto px-4 md:px-6">
              <div className="grid items-center gap-12 lg:grid-cols-2">
                <div className="flex flex-col justify-center space-y-6">
                  <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tighter">
                    Transform Your Career with Expert Guidance
                  </h2>
                  <ul className="space-y-4 text-lg text-gray-600 md:text-xl">
                    <li>
                      <span className="font-semibold">✓ Accelerate Your Growth:</span> Gain years of industry insights in just hours through our 1-1 sessions.
                    </li>
                    <li>
                      <span className="font-semibold">✓ Expand Your Network:</span> Connect with industry leaders and peers in our exclusive classes and webinars.
                    </li>
                    <li>
                      <span className="font-semibold">✓ Stay Ahead of the Curve:</span> Access cutting-edge knowledge and trends through our conferences.
                    </li>
                  </ul>
                  <Link
                    className="inline-flex w-full sm:w-auto items-center justify-center rounded-md bg-gray-900 px-6 py-3 text-sm font-medium text-white shadow transition-colors hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-950"
                    href="#"
                  >
                    Start Your Journey
                  </Link>
                </div>
                <div className="flex justify-center">
                  {renderImage(images, 1, "/placeholder.svg", 550, 310)}
                </div>
              </div>
            </div>
          </section>

          <section id="benefits" className="w-full py-16 md:py-24 lg:py-32 bg-gray-100">
            <div className="container mx-auto px-4 md:px-6">
              <div className="flex flex-col items-center justify-center space-y-6 text-center">
                <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tighter">
                  Unlock Your Full Potential
                </h2>
                <p className="max-w-[900px] text-lg text-gray-600 md:text-xl">
                  Experience transformative growth with our comprehensive mentorship program.
                </p>
              </div>
              <div className="grid lg:grid-cols-2 gap-12 mt-12">
                <div className="flex flex-col justify-center space-y-6">
                  <ul className="space-y-6">
                    <li>
                      <h3 className="text-xl font-bold">Tailored Career Acceleration</h3>
                      <p className="text-gray-600">
                        Receive a personalized roadmap to fast-track your career goals, designed by industry experts who've walked the path.
                      </p>
                    </li>
                    <li>
                      <h3 className="text-xl font-bold">Insider Knowledge & Strategies</h3>
                      <p className="text-gray-600">
                        Gain exclusive insights and proven strategies to navigate complex career challenges and seize hidden opportunities.
                      </p>
                    </li>
                    <li>
                      <h3 className="text-xl font-bold">Confidence & Skill Mastery</h3>
                      <p className="text-gray-600">
                        Develop unshakeable confidence and master critical skills through hands-on guidance and real-world application.
                      </p>
                    </li>
                  </ul>
                </div>
                <div className="flex justify-center items-center">
                  {renderImage(images, 2, "/placeholder.svg", 550, 310)}
                </div>
              </div>
            </div>
          </section>

          <section className="w-full border-y pt-6 md:pt-12 lg:pt-16 xl:pt-20">
            <div className="px-4 md:px-6 space-y-10 xl:space-y-16">
              <div className="grid max-w-[1300px] mx-auto gap-4 px-4 sm:px-6 md:px-10 md:grid-cols-2 md:gap-16">
                <div>
                  <h1 className="lg:leading-tighter text-3xl font-bold tracking-tighter sm:text-4xl md:text-5xl xl:text-[3.4rem] 2xl:text-[3.75rem]">
                    The Best Experts in the World
                  </h1>
                </div>
                <div className="flex flex-col items-start space-y-4">
                  <p className="mx-auto max-w-[700px] text-gray-500 md:text-xl dark:text-gray-400">
                    Explore our wide range of consultants and find the right one
                    for your business.
                  </p>
                  <div className="space-x-4">
                    <Link
                      className="inline-flex h-9 items-center justify-center rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-gray-50 shadow transition-colors hover:bg-gray-900/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gray-950 disabled:pointer-events-none disabled:opacity-50 dark:bg-gray-50 dark:text-gray-900 dark:hover:bg-gray-50/90 dark:focus-visible:ring-gray-300"
                      href="#"
                    >
                      Get Started
                    </Link>
                  </div>
                </div>
              </div>
              <div className="w-full max-w-[1600px] mx-auto overflow-hidden">
                {renderImage(images, 3, "/placeholder.svg", 1300, 867)}
              </div>
            </div>
          </section>

          <section className="w-full py-12 md:py-24 lg:py-32 bg-gray-100">
            <div className="container mx-auto px-4 md:px-6">
              <div className="text-center mb-12">
                <h2 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold tracking-tighter">
                  Meet our Featured Experts
                </h2>
                <p className="mt-4 mx-auto max-w-[700px] text-gray-500 md:text-xl">
                  We have a diverse team of experts ready to share their
                  knowledge and expertise with you.
                </p>
                <Button className="mt-8 dark:bg-gray-800 text-white hover:bg-gray-700 transition-colors duration-300">
                  View All Experts
                </Button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-8">
                {[
                  { name: "Expert 1", expertise: "Business and entrepreneurship" },
                  { name: "Expert 2", expertise: "Nutrition and wellness" },
                  { name: "Expert 3", expertise: "Digital marketing and SEO" },
                  { name: "Expert 4", expertise: "Personal development and coaching" },
                  { name: "Expert 5", expertise: "Higher Education and Travel" }
                ].map((expert, index) => (
                  <Card key={index} className="hover:shadow-xl transition-shadow duration-300 hover:-translate-y-1">
                    <CardHeader>
                      <Avatar className="mx-auto mb-4" />
                      <h3 className="text-lg font-bold">{expert.name}</h3>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        Expert in {expert.expertise}.
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          </section>

          <section className="container mx-auto px-4 py-16 md:py-24 lg:py-32">
            <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-center mb-12">
              Check out our various offerings
            </h2>
            <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-4">
              {['1-1 Sessions', 'Subscriptions', 'Classes', 'Webinars',].map((offering) => (
                <Card key={offering} className="rounded-lg shadow-md transition-transform duration-300 hover:-translate-y-2">
                  <CardHeader className="text-xl font-semibold">{offering}</CardHeader>
                  <CardContent>
                    <p className="text-gray-600">
                      {offering === '1-1 Sessions' && 'Connect with experts for personal sessions and gain insights from industry leaders.'}
                      {offering === 'Subscriptions' && 'Get unlimited access to our platform with a subscription plan tailored to your needs.'}
                      {offering === 'Classes' && 'Join classes offered by professionals and broaden your knowledge in various fields.'}
                      {offering === 'Webinars' && 'Participate in webinars to learn from experts in a collaborative setting.'}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          <section className="w-full py-16 md:py-24 lg:py-32 bg-gray-100">
            <div className="container mx-auto px-4 md:px-6 text-center">
              <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tighter mb-4">
                Join our Community of Experts
              </h2>
              <p className="text-lg text-gray-600 md:text-xl max-w-[600px] mx-auto mb-8">
                Share your expertise with people who need it and grow your
                personal brand.
              </p>
              <Button className="w-full sm:w-auto bg-gray-900 text-white hover:bg-gray-800">
                Become an Expert
              </Button>
            </div>
          </section>
        </main>
        <Faq />
        <TestimonialsSection />
        <MeetTheTeam />
        <Newsletter />
      </AnimatePresence>
    </ReduxProvider>
  );
}

/**
 * v0 by Vercel.
 * @see https://v0.dev/t/pbezvcjADh4
 * Documentation: https://v0.dev/docs#integrating-generated-code-into-your-nextjs-app
 */

function MeetTheTeam() {
  return (
    <section className="w-full py-16 md:py-24 lg:py-32">
      <div className="container mx-auto px-4 md:px-6">
        <div className="text-center mb-12">
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tighter mb-4">
            Meet the Team
          </h2>
          <p className="text-lg text-gray-600 md:text-xl max-w-[700px] mx-auto">
            Get to know the talented individuals behind our company.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
          {[
            { name: 'John Doe', role: 'CEO', description: 'John is the visionary behind our company, leading the team to new heights.' },
            { name: 'Jane Appleseed', role: 'CTO', description: 'Jane leads our engineering team, ensuring our products are cutting-edge and reliable.' },
            { name: 'Kara Sato', role: 'Head of Design', description: 'Kara leads our design team, ensuring our products have a beautiful and intuitive user experience.' },
            { name: 'Michael Reeves', role: 'Head of Marketing', description: 'Michael leads our marketing efforts, ensuring our brand resonates with our target audience.' },
            { name: 'Lisa Simmons', role: 'Head of Sales', description: 'Lisa leads our sales team, ensuring our customers receive top-notch service.' },
            { name: 'John Bauer', role: 'Head of Customer Support', description: 'John leads our customer support team, ensuring our customers have a seamless experience.' },
            { name: 'Sarah Mayer', role: 'Head of Human Resources', description: 'Sarah leads our HR team, ensuring our employees have the support they need to thrive.' },
            { name: 'David Wong', role: 'Head of Finance', description: 'David leads our finance team, ensuring our company remains financially sound.' },
          ].map((member, index) => (
            <div key={index} className="flex flex-col items-center justify-center space-y-4 rounded-lg bg-white p-6 shadow-lg transition-transform duration-300 hover:-translate-y-2 hover:shadow-xl">
              <Avatar className="w-24 h-24">
                <AvatarImage src={`/placeholder-user-${index + 1}.jpg`} />
                <AvatarFallback>{member.name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
              </Avatar>
              <div className="space-y-2 text-center">
                <h4 className="text-xl font-semibold">{member.name}</h4>
                <p className="text-sm text-gray-600">{member.role}</p>
                <p className="text-sm text-gray-600">{member.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
