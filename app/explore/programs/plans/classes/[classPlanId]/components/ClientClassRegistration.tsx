"use client";

import { useSession } from "next-auth/react";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ClassPlanProgram } from "@/app/explore/programs/utils";

type ClientClassRegistrationProps = {
  readonly plan: ClassPlanProgram;
};

export function ClientClassRegistration({
  plan,
}: ClientClassRegistrationProps) {
  const { id: classId, price, classes } = plan; // Removed language
  const startDate = classes?.[0]?.startDate; // Corrected to startDate
  const { data: session } = useSession();
  const isLoggedIn = !!session?.user;

  const handleRegistration = () => {
    if (!isLoggedIn) {
      window.location.href = `/auth/signin?callbackUrl=${encodeURIComponent(window.location.href)}`;
      return;
    }
    window.location.href = `/checkout/events/class/${classId}`;
  };

  if (!isLoggedIn) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Register for Class</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-gray-600 mb-4">
            Please sign in to register for this class.
          </p>
          {/* TODO: Implement registration form for non-logged in users
          <div className="space-y-4">
            <div>
              <label
                htmlFor="name"
                className="block text-sm font-medium text-gray-700"
              >
                Full Name
              </label>
              <input
                type="text"
                id="name"
                name="name"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
                required
              />
            </div>
            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-gray-700"
              >
                Email
              </label>
              <input
                type="email"
                id="email"
                name="email"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
                required
              />
            </div>
            <div>
              <label
                htmlFor="phone"
                className="block text-sm font-medium text-gray-700"
              >
                Phone Number
              </label>
              <input
                type="tel"
                id="phone"
                name="phone"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
                placeholder="+1234567890"
              />
            </div>
            <div>
              <label
                htmlFor="preferredLanguage"
                className="block text-sm font-medium text-gray-700"
              >
                Preferred Language
              </label>
              <input
                type="text"
                id="preferredLanguage"
                name="preferredLanguage"
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2"
                placeholder="e.g., English, Spanish, etc."
                defaultValue={language || ""}
              />
            </div>
          </div>
          */}
          <Button
            onClick={handleRegistration}
            className="w-full bg-black hover:bg-gray-800"
          >
            Sign in to Register
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Join Class</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-gray-600 mb-4">
          {startDate
            ? `Class starts on ${new Date(startDate).toLocaleString(undefined, {
                dateStyle: "long",
                timeStyle: "short",
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              })}`
            : "Start date to be announced"}
        </p>
      </CardContent>
      <CardFooter>
        <Button
          onClick={handleRegistration}
          className="w-full bg-black hover:bg-gray-800"
        >
          Pay ${price} USD & Register Now
        </Button>
      </CardFooter>
    </Card>
  );
}
