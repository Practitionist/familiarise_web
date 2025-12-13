"use client";

import { motion } from "framer-motion";
import { MessageSquare } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function NewsletterSection() {
  const [email, setEmail] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Handle newsletter signup
    console.log("Newsletter signup:", email);
    setEmail("");
  };

  return (
    <section className="py-20 md:py-32 bg-black relative overflow-hidden">
      {/* Animated background */}
      <div className="absolute inset-0">
        <div className="absolute top-1/3 left-1/4 w-[500px] h-[500px] bg-zinc-800/30 rounded-full blur-[120px] animate-blob" />
        <div className="absolute bottom-1/3 right-1/4 w-[400px] h-[400px] bg-zinc-700/20 rounded-full blur-[100px] animate-blob animation-delay-2000" />
      </div>
      <div className="absolute inset-0 grid-pattern opacity-20" />

      <div className="container mx-auto px-4 md:px-6 relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          viewport={{ once: true }}
          className="max-w-2xl mx-auto text-center"
        >
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-zinc-700 to-zinc-900 flex items-center justify-center mx-auto mb-6 shadow-lg">
            <MessageSquare className="w-8 h-8 text-white" />
          </div>
          <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold text-white mb-4">
            Stay in the <span className="silver-text">loop</span>
          </h2>
          <p className="text-lg text-zinc-500 mb-8">
            Get expert tips, career advice, and exclusive offers delivered to your inbox weekly.
          </p>
          
          <form className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto" onSubmit={handleSubmit}>
            <Input
              type="email"
              placeholder="Enter your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-14 bg-zinc-900 border-zinc-800 text-white placeholder:text-zinc-600 rounded-xl focus:border-zinc-600 focus:ring-zinc-600"
            />
            <Button 
              type="submit"
              size="lg" 
              className="h-14 bg-white text-zinc-900 hover:bg-zinc-200 px-8 rounded-xl font-medium shrink-0"
            >
              Subscribe
            </Button>
          </form>
          
          <p className="text-sm text-zinc-600 mt-4">
            No spam, unsubscribe anytime.{" "}
            <Link href="/privacy" className="underline hover:text-zinc-400 transition-colors">
              Privacy Policy
            </Link>
          </p>
        </motion.div>
      </div>
    </section>
  );
}

