import { AuthSidePanel } from "@/components/auth/AuthSidePanel";
import { SignInForm } from "./SignInForm";

export const revalidate = 3600;

export default function Page() {
  return <SignInForm sidePanel={<AuthSidePanel variant="signin" />} />;
}
