'use client';

import { Mic, Video } from "lucide-react";
export default function PermissionPrompt() {
  return (
    <div className="flex flex-col items-center gap-3 pt-32">
      <div className="flex items-center gap-3">
        <Video size={40} />
        <Mic size={40} />
      </div>
      <p className="text-center">
        Please allow access to your microphone and camera to join the call
      </p>
    </div>
  );
}
