import { AuthSidePanel } from "@/components/auth/AuthSidePanel";
import { SignUpForm } from "./SignUpForm";

export const revalidate = 3600;

export default function Page() {
  return <SignUpForm sidePanel={<AuthSidePanel variant="signup" />} />;
}
