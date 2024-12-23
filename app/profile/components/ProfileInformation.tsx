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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/use-toast";
import { MailIcon, PhoneIcon } from "./Icons";
import Image from "next/image";
import { useState } from "react";
import { User } from "@prisma/client";
import { Session } from "next-auth";

interface ProfileInformationProps {
  session: Readonly<Session | null>;
}

export function ProfileInformation({
  session,
}: Readonly<ProfileInformationProps>) {
  const [name, setName] = useState(session?.user?.name ?? "");
  const [phone, setPhone] = useState(session?.user?.phone ?? "");
  const [address, setAddress] = useState(session?.user?.address ?? "");

  const handleUpdateProfile = async (e: { preventDefault: () => void }) => {
    e.preventDefault();
    try {
      const res = await fetch(`/api/user/${session?.user?.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name, phone, address }),
      });

      if (res.ok) {
        const updatedUser: User = await res.json();
        setName(updatedUser.name ?? "");
        setPhone(updatedUser.phone ?? "");
        setAddress(updatedUser.address ?? "");

        toast({
          title: "Profile Updated",
          description: "Your profile has been updated successfully.",
          variant: "default",
        });
      } else {
        console.error("Failed to update profile");
      }
    } catch (error) {
      console.error("An unexpected error occurred:", error);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile Information</CardTitle>
        <CardDescription>
          View and update your personal information.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center space-x-4 mb-6">
          <Avatar>
            <AvatarImage
              src={session?.user?.image ?? "https://github.com/shadcn.png"}
            />
            <AvatarFallback>CN</AvatarFallback>
          </Avatar>

          <div>
            <p className="text-lg font-medium">{session?.user?.name ?? ""}</p>
            <p className="text-sm text-gray-500">Full Name</p>
          </div>
          <Dialog>
            <DialogTrigger asChild>
              <Button className="w-1/2" variant="outline">
                Upload Profile Picture
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[425px] bg-white shadow-lg rounded-lg p-6">
              <DialogHeader>
                <DialogTitle>Update Profile Picture</DialogTitle>
                <DialogDescription>
                  Upload a new profile picture to update your account.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 py-4">
                <div className="grid items-center gap-4">
                  <div className="flex flex-col items-center justify-center">
                    <Image
                      src="/placeholder.svg"
                      alt="Profile Preview"
                      className="rounded-full"
                      width={100}
                      height={100}
                    />
                    <p className="mt-2 text-sm text-muted-foreground">
                      Preview of selected image
                    </p>
                  </div>
                  <div className="flex flex-col space-y-1.5">
                    <Label htmlFor="profile-picture">Profile Picture</Label>
                    <Input id="profile-picture" type="file" />
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline">Cancel</Button>
                <Button
                  type="submit"
                  style={{ backgroundColor: "black", color: "white" }}
                >
                  Update
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        <div className="space-y-4">
          <div className="flex items-center">
            <MailIcon className="w-5 h-5 text-gray-400 mr-2" />
            <div>
              <p className="text-sm font-medium">Address</p>
              <p className="text-sm">{session?.user?.address ?? ""}</p>
            </div>
          </div>
          <div className="flex items-center">
            <PhoneIcon className="w-5 h-5 text-gray-400 mr-2" />
            <div>
              <p className="text-sm font-medium">Phone</p>
              <p className="text-sm">{session?.user?.phone ?? ""}</p>
            </div>
          </div>
        </div>
      </CardContent>
      <CardFooter>
        <Dialog>
          <DialogTrigger asChild>
            <Button className="w-full" variant="outline">
              Update Information
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[450px] bg-white shadow-lg rounded-lg p-6">
            <DialogHeader>
              <DialogTitle>Update Information</DialogTitle>
              <DialogDescription>
                Update your personal information below.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleUpdateProfile}>
              <div className="grid gap-4 py-4">
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label htmlFor="name" className="text-right">
                    Full Name
                  </Label>
                  <Input
                    id="name"
                    placeholder="John Doe"
                    className="col-span-3"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label htmlFor="phone" className="text-right">
                    Phone
                  </Label>
                  <Input
                    id="phone"
                    placeholder="+1 (555) 555-5555"
                    className="col-span-3"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label htmlFor="address" className="text-right">
                    Address
                  </Label>
                  <Input
                    id="address"
                    placeholder="1234 Elm Street"
                    className="col-span-3"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  type="submit"
                  style={{ backgroundColor: "black", color: "white" }}
                >
                  Update Information
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardFooter>
    </Card>
  );
}
