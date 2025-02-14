import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

export default async function MeetingsLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getServerSession();

  if (!session?.user) {
    redirect("/auth/signin");
  }

  return <main className="mt-20 container mx-auto px-4">{children}</main>;
}

export const metadata = {
  title: "Video Meetings",
  description: "Create and join video meetings",
};
