"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import Link from "next/link";
import { SettingsIcon, TrashIcon } from "./Icons";
import { Session } from "next-auth";

interface AccountSettingsProps {
  session: Readonly<Session | null>;
}

export function AccountSettings({ session }: Readonly<AccountSettingsProps>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account Settings</CardTitle>
        <CardDescription>
          Manage your account settings and preferences.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center mb-4">
          <Avatar>
            <AvatarImage src="" />
            <AvatarFallback>JP</AvatarFallback>
          </Avatar>
          <div>
            <p className="text-sm font-medium">Current User</p>
            <p className="text-sm text-gray-500">
              {session?.user?.email ?? ""}
            </p>
          </div>
        </div>
        <div className="space-y-4">
          <div className="flex items-center">
            <SettingsIcon className="w-5 h-5 text-gray-400 mr-2" />
            <div>
              <Link className="text-sm font-medium underline" href="#">
                Logout of all devices
              </Link>
              <p className="text-sm text-gray-500">
                This will logout your account from all devices.
              </p>
            </div>
          </div>
          <div className="flex items-center">
            <TrashIcon className="w-5 h-5 text-red-500 mr-2" />
            <div>
              <Link
                className="text-sm font-medium underline text-red-500"
                href="#"
              >
                Delete Account
              </Link>
              <p className="text-sm text-gray-500">
                This will permanently delete your account.
              </p>
            </div>
          </div>
        </div>
      </CardContent>
      <CardFooter>
        <Button className="w-full" variant="outline">
          Save Changes
        </Button>
      </CardFooter>
    </Card>
  );
}
