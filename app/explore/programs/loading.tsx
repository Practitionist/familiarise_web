"use client";

import { GraduationCap } from "lucide-react";

export default function Loading() {
  return (
    <main className="min-h-screen bg-white flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="relative">
          <div className="w-16 h-16 border-4 border-zinc-200 border-t-zinc-900 rounded-full animate-spin" />
          <div className="absolute inset-0 flex items-center justify-center">
            <GraduationCap className="w-6 h-6 text-zinc-400" />
          </div>
        </div>
        <p className="text-zinc-500 text-sm">Loading programs...</p>
      </div>
    </main>
  );
}
