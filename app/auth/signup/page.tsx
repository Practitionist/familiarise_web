import { AuthSidePanel } from "@/components/auth/AuthSidePanel";
import { SignUpForm } from "./SignUpForm";

export const revalidate = 3600;

// The panel sits outside the form's Suspense boundary so it is in the static HTML.
export default function Page() {
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <AuthSidePanel variant="signup" />
      <SignUpForm />
    </div>
  );
}
