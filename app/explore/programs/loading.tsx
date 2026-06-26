"use client";

import { GraduationCap } from "lucide-react";

export default function Loading() {
  return (
    <main className="min-h-screen bg-background flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="relative">
          <div className="w-16 h-16 border-4 border-muted border-t-primary rounded-full animate-spin" />
          <div className="absolute inset-0 flex items-center justify-center">
            <GraduationCap className="w-6 h-6 text-muted-foreground/70" />
          </div>
        </div>
        <p className="text-muted-foreground text-sm">Loading programs...</p>
      </div>
    </main>
  );
}
