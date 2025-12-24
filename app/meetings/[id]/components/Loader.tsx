"use client";

import { Loader2, Video } from "lucide-react";

const Loader = () => {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-br from-zinc-950 via-zinc-900 to-zinc-950">
      {/* Background pattern */}
      <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxnIGZpbGw9IiNmZmYiIGZpbGwtb3BhY2l0eT0iMC4wMiI+PGNpcmNsZSBjeD0iMzAiIGN5PSIzMCIgcj0iMiIvPjwvZz48L2c+PC9zdmc+')] opacity-50" />

      <div className="relative z-10 flex flex-col items-center">
        {/* Icon with glow */}
        <div className="relative mb-6">
          <div className="absolute inset-0 bg-emerald-500/20 blur-xl rounded-full" />
          <div className="relative w-20 h-20 bg-zinc-800 rounded-2xl flex items-center justify-center border border-zinc-700">
            <Video className="w-8 h-8 text-emerald-500" />
          </div>
        </div>

        {/* Spinner */}
        <Loader2 className="h-8 w-8 animate-spin text-emerald-500 mb-4" />

        {/* Text */}
        <p className="text-lg font-medium text-white mb-1">
          Loading meeting...
        </p>
        <p className="text-sm text-zinc-500">Preparing your video experience</p>
      </div>
    </div>
  );
};

export default Loader;
