import { Loader2 } from "lucide-react";

export default function LoadingPage() {
  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-80px)]">
      <Loader2 className="animate-spin" />
    </div>
  );
}
