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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { User } from "@prisma/client";
import { useSession } from "@/lib/auth-client";
import Image from "next/image";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import {
  User as UserIcon,
  Settings,
  Trash2,
  Mail,
  Phone,
  MapPin,
  Cookie,
  Bell,
  AtSign,
  MessageSquare,
  Sparkles,
  LogOut,
  Shield,
  Camera,
  Upload,
} from "lucide-react";
import { motion } from "framer-motion";

const fadeInUp = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4 } },
};

const staggerChildren = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1 },
  },
};

export default function Profile() {
  const { data: session } = useSession();
  const { toast } = useToast();
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
        toast({
          title: "Error",
          description: "Failed to update profile. Please try again.",
          variant: "destructive",
        });
      }
    } catch (error) {
      console.error("An unexpected error occurred:", error);
      toast({
        title: "Error",
        description: "An unexpected error occurred.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 pt-20">
      {/* Hero Header */}
      <div className="bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-800 relative overflow-hidden">
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:32px_32px]" />
        <div className="max-w-5xl mx-auto px-4 py-12 md:py-16 relative">
          <div className="flex flex-col md:flex-row items-center gap-6">
            <div className="relative group">
              <Avatar className="h-28 w-28 ring-4 ring-zinc-700 ring-offset-4 ring-offset-zinc-900">
                <AvatarImage src={session?.user?.image ?? ""} />
                <AvatarFallback className="bg-zinc-700 text-zinc-200 text-3xl font-semibold">
                  {session?.user?.name?.charAt(0) || "U"}
                </AvatarFallback>
              </Avatar>
              <Dialog>
                <DialogTrigger asChild>
                  <button className="absolute bottom-0 right-0 h-10 w-10 rounded-full bg-white text-zinc-900 flex items-center justify-center shadow-lg hover:bg-zinc-100 transition-colors">
                    <Camera className="h-5 w-5" />
                  </button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>Update Profile Picture</DialogTitle>
                    <DialogDescription>
                      Upload a new profile picture to personalize your account.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="flex flex-col items-center gap-4 py-6">
                    <div className="h-32 w-32 rounded-full bg-zinc-100 flex items-center justify-center">
                      <Upload className="h-10 w-10 text-zinc-400" />
                    </div>
                    <Input
                      id="profile-picture"
                      type="file"
                      accept="image/*"
                      className="max-w-xs"
                    />
                  </div>
                  <DialogFooter className="gap-2">
                    <Button variant="outline">Cancel</Button>
                    <Button className="bg-zinc-900 hover:bg-zinc-800 text-white">
                      Upload
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
            <div className="text-center md:text-left">
              <h1 className="text-3xl md:text-4xl font-bold text-white mb-2">
                {session?.user?.name || "Welcome"}
              </h1>
              <p className="text-zinc-400 text-lg">
                {session?.user?.email || "Manage your account settings"}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <motion.div
        initial="hidden"
        animate="visible"
        variants={staggerChildren}
        className="max-w-5xl mx-auto px-4 py-10 -mt-8"
      >
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
          {/* Profile Information */}
          <motion.div variants={fadeInUp} className="h-full">
            <Card className="border-zinc-200 shadow-sm hover:shadow-md transition-shadow h-full flex flex-col">
              <CardHeader className="pb-4">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-zinc-100 flex items-center justify-center">
                    <UserIcon className="h-5 w-5 text-zinc-600" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">
                      Profile Information
                    </CardTitle>
                    <CardDescription>Your personal details</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 flex-1">
                <div className="flex items-center gap-4 p-4 rounded-xl bg-zinc-50 border border-zinc-100">
                  <Avatar className="h-14 w-14 ring-2 ring-zinc-200">
                    <AvatarImage src={session?.user?.image ?? ""} />
                    <AvatarFallback className="bg-zinc-200 text-zinc-600 font-semibold">
                      {session?.user?.name?.charAt(0) || "U"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <p className="font-semibold text-zinc-900">
                      {session?.user?.name || "Your Name"}
                    </p>
                    <p className="text-sm text-zinc-500">
                      {session?.user?.email || "your@email.com"}
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center gap-3 p-3 rounded-lg hover:bg-zinc-50 transition-colors">
                    <div className="h-9 w-9 rounded-lg bg-zinc-100 flex items-center justify-center">
                      <MapPin className="h-4 w-4 text-zinc-500" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-zinc-700">
                        Address
                      </p>
                      <p className="text-sm text-zinc-500">
                        {session?.user?.address || "Not provided"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 p-3 rounded-lg hover:bg-zinc-50 transition-colors">
                    <div className="h-9 w-9 rounded-lg bg-zinc-100 flex items-center justify-center">
                      <Phone className="h-4 w-4 text-zinc-500" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm font-medium text-zinc-700">Phone</p>
                      <p className="text-sm text-zinc-500">
                        {session?.user?.phone || "Not provided"}
                      </p>
                    </div>
                  </div>
                </div>
              </CardContent>
              <CardFooter className="pt-0 mt-auto">
                <Dialog>
                  <DialogTrigger asChild>
                    <Button
                      variant="outline"
                      className="w-full border-zinc-200 hover:bg-zinc-50"
                    >
                      <Settings className="h-4 w-4 mr-2" />
                      Update Information
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle>Update Information</DialogTitle>
                      <DialogDescription>
                        Update your personal information below.
                      </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={handleUpdateProfile}>
                      <div className="space-y-4 py-4">
                        <div className="space-y-2">
                          <Label htmlFor="name">Full Name</Label>
                          <Input
                            id="name"
                            placeholder="John Doe"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="phone">Phone</Label>
                          <Input
                            id="phone"
                            placeholder="+1 (555) 555-5555"
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="address">Address</Label>
                          <Input
                            id="address"
                            placeholder="1234 Elm Street"
                            value={address}
                            onChange={(e) => setAddress(e.target.value)}
                          />
                        </div>
                      </div>
                      <DialogFooter>
                        <Button
                          type="submit"
                          className="bg-zinc-900 hover:bg-zinc-800 text-white"
                        >
                          Save Changes
                        </Button>
                      </DialogFooter>
                    </form>
                  </DialogContent>
                </Dialog>
              </CardFooter>
            </Card>
          </motion.div>

          {/* Account Settings */}
          <motion.div variants={fadeInUp} className="h-full">
            <Card className="border-zinc-200 shadow-sm hover:shadow-md transition-shadow h-full flex flex-col">
              <CardHeader className="pb-4">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-zinc-100 flex items-center justify-center">
                    <Shield className="h-5 w-5 text-zinc-600" />
                  </div>
                  <div>
                    <CardTitle className="text-lg">Account Settings</CardTitle>
                    <CardDescription>
                      Security and account management
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 flex-1">
                <div className="flex items-center gap-4 p-4 rounded-xl bg-zinc-50 border border-zinc-100">
                  <Avatar className="h-12 w-12 ring-2 ring-zinc-200">
                    <AvatarImage src={session?.user?.image ?? ""} />
                    <AvatarFallback className="bg-zinc-200 text-zinc-600 font-semibold">
                      {session?.user?.name?.charAt(0) || "U"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <p className="font-medium text-zinc-900">Current User</p>
                    <p className="text-sm text-zinc-500">
                      {session?.user?.email || "user@example.com"}
                    </p>
                  </div>
                </div>

                <button className="w-full flex items-center gap-3 p-4 rounded-xl hover:bg-zinc-50 transition-colors text-left border border-transparent hover:border-zinc-100">
                  <div className="h-10 w-10 rounded-lg bg-zinc-100 flex items-center justify-center">
                    <LogOut className="h-5 w-5 text-zinc-600" />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-zinc-900">
                      Logout of all devices
                    </p>
                    <p className="text-sm text-zinc-500">
                      Sign out from all active sessions
                    </p>
                  </div>
                </button>

                <button className="w-full flex items-center gap-3 p-4 rounded-xl hover:bg-red-50 transition-colors text-left border border-transparent hover:border-red-100 group">
                  <div className="h-10 w-10 rounded-lg bg-red-50 group-hover:bg-red-100 flex items-center justify-center transition-colors">
                    <Trash2 className="h-5 w-5 text-red-500" />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-red-600">Delete Account</p>
                    <p className="text-sm text-zinc-500">
                      Permanently delete your account and data
                    </p>
                  </div>
                </button>
              </CardContent>
            </Card>
          </motion.div>
        </div>

        {/* Cookie Preferences */}
        <motion.div variants={fadeInUp} className="mt-6">
          <Card className="border-zinc-200 shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="pb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-amber-50 flex items-center justify-center">
                  <Cookie className="h-5 w-5 text-amber-600" />
                </div>
                <div>
                  <CardTitle className="text-lg">Cookie Preferences</CardTitle>
                  <CardDescription>
                    Manage how we use cookies on your browser
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-3">
                <div className="p-4 rounded-xl border border-zinc-100 hover:border-zinc-200 transition-colors">
                  <div className="flex items-center justify-between mb-3">
                    <Label
                      htmlFor="essential"
                      className="font-semibold text-zinc-900"
                    >
                      Essential
                    </Label>
                    <Switch id="essential" defaultChecked disabled />
                  </div>
                  <p className="text-sm text-zinc-500">
                    Required for basic site functionality
                  </p>
                </div>
                <div className="p-4 rounded-xl border border-zinc-100 hover:border-zinc-200 transition-colors">
                  <div className="flex items-center justify-between mb-3">
                    <Label
                      htmlFor="analytics"
                      className="font-semibold text-zinc-900"
                    >
                      Analytics
                    </Label>
                    <Switch id="analytics" />
                  </div>
                  <p className="text-sm text-zinc-500">
                    Help us improve site performance
                  </p>
                </div>
                <div className="p-4 rounded-xl border border-zinc-100 hover:border-zinc-200 transition-colors">
                  <div className="flex items-center justify-between mb-3">
                    <Label
                      htmlFor="marketing"
                      className="font-semibold text-zinc-900"
                    >
                      Marketing
                    </Label>
                    <Switch id="marketing" />
                  </div>
                  <p className="text-sm text-zinc-500">
                    Personalized recommendations
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Notification Preferences */}
        <motion.div variants={fadeInUp} className="mt-6">
          <Card className="border-zinc-200 shadow-sm hover:shadow-md transition-shadow">
            <CardHeader className="pb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-indigo-50 flex items-center justify-center">
                  <Bell className="h-5 w-5 text-indigo-600" />
                </div>
                <div>
                  <CardTitle className="text-lg">
                    Notification Preferences
                  </CardTitle>
                  <CardDescription>
                    Choose what updates you want to receive
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-100 hover:border-zinc-200 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-lg bg-zinc-100 flex items-center justify-center">
                      <Bell className="h-4 w-4 text-zinc-600" />
                    </div>
                    <div>
                      <p className="font-medium text-zinc-900">
                        All Notifications
                      </p>
                      <p className="text-sm text-zinc-500">
                        Receive all updates and alerts
                      </p>
                    </div>
                  </div>
                  <Switch id="all" />
                </div>
                <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-100 hover:border-zinc-200 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-lg bg-zinc-100 flex items-center justify-center">
                      <AtSign className="h-4 w-4 text-zinc-600" />
                    </div>
                    <div>
                      <p className="font-medium text-zinc-900">Mentions</p>
                      <p className="text-sm text-zinc-500">
                        When someone mentions you
                      </p>
                    </div>
                  </div>
                  <Switch id="mentions" />
                </div>
                <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-100 hover:border-zinc-200 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-lg bg-zinc-100 flex items-center justify-center">
                      <MessageSquare className="h-4 w-4 text-zinc-600" />
                    </div>
                    <div>
                      <p className="font-medium text-zinc-900">
                        Direct Messages
                      </p>
                      <p className="text-sm text-zinc-500">
                        New messages from experts
                      </p>
                    </div>
                  </div>
                  <Switch id="direct-messages" />
                </div>
                <div className="flex items-center justify-between p-4 rounded-xl border border-zinc-100 hover:border-zinc-200 transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-lg bg-zinc-100 flex items-center justify-center">
                      <Sparkles className="h-4 w-4 text-zinc-600" />
                    </div>
                    <div>
                      <p className="font-medium text-zinc-900">
                        Product Updates
                      </p>
                      <p className="text-sm text-zinc-500">
                        New features and improvements
                      </p>
                    </div>
                  </div>
                  <Switch id="updates" />
                </div>
              </div>
            </CardContent>
            <CardFooter className="pt-0">
              <Button className="ml-auto bg-zinc-900 hover:bg-zinc-800 text-white">
                Save Preferences
              </Button>
            </CardFooter>
          </Card>
        </motion.div>
      </motion.div>
    </div>
  );
}
