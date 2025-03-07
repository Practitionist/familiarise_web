"use client";

import { Mic, Video, RefreshCw } from "lucide-react";
import Button from "./button";

interface PermissionPromptProps {
  onRetry: () => void;
}

export default function PermissionPrompt({ onRetry }: Readonly<PermissionPromptProps>) {
  return (
    <div className="flex flex-col items-center gap-6 pt-32">
      <div className="flex items-center gap-3">
        <Video size={40} />
        <Mic size={40} />
      </div>
      <div className="text-center space-y-4">
        <p className="text-lg">
          Please allow access to your microphone and camera to join the call
        </p>
        <p className="text-sm text-muted-foreground">
          If you denied permissions, you'll need to enable them in your browser settings
        </p>
      </div>
      <Button onClick={onRetry} className="flex items-center gap-2">
        <RefreshCw size={16} />
        Retry Permissions
      </Button>
    </div>
  );
}
