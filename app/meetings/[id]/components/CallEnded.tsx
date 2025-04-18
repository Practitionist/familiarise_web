"use client";

import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";
import { PhoneOff, RefreshCw } from "lucide-react";

interface CallEndedProps {
  message?: string;
  onRejoin?: () => void;
}

const CallEnded = ({
  message = "The call has been ended by the host",
  onRejoin,
}: CallEndedProps) => {
  const router = useRouter();

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 text-white">
      <div className="bg-gray-800 rounded-lg p-8 max-w-md text-center shadow-lg">
        <div className="flex justify-center mb-4">
          <div className="bg-red-500 p-4 rounded-full">
            <PhoneOff size={48} />
          </div>
        </div>
        <h1 className="text-2xl font-bold mb-4">{message}</h1>
        <p className="text-gray-300 mb-6">
          You can return to the dashboard or try to rejoin the meeting.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Button
            onClick={() => router.push("/dashboard")}
            className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2"
          >
            Return to Dashboard
          </Button>

          {onRejoin && (
            <Button
              onClick={onRejoin}
              className="bg-green-600 hover:bg-green-700 text-white px-6 py-2 flex items-center gap-2"
            >
              <RefreshCw size={16} />
              Try to Rejoin
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default CallEnded;
