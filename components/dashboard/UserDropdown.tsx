"use client";

import { signOut } from "@/lib/auth-client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { User, Settings, ArrowLeft, LogOut } from "lucide-react";
import Link from "next/link";

interface UserDropdownProps {
  userName?: string | null;
  userImage?: string | null;
  userRole: "CONSULTANT" | "CONSULTEE" | "ADMIN" | "STAFF";
  settingsPath: string;
  profilePath?: string;
}

export function UserDropdown({
  userName,
  userImage,
  userRole,
  settingsPath,
  profilePath,
}: UserDropdownProps) {
  const getRoleBadgeColor = () => {
    switch (userRole) {
      case "ADMIN":
        return "text-red-600 bg-red-50";
      case "CONSULTANT":
        return "text-emerald-600 bg-emerald-50";
      case "CONSULTEE":
        return "text-blue-600 bg-blue-50";
      case "STAFF":
        return "text-amber-600 bg-amber-50";
      default:
        return "text-zinc-600 bg-zinc-50";
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="relative h-8 w-8 rounded-full ring-2 ring-zinc-200 hover:ring-zinc-400 transition-all focus:outline-none focus:ring-2 focus:ring-zinc-400">
          <Avatar className="h-8 w-8">
            <AvatarImage
              src={userImage || "/placeholder-user.jpg"}
              alt={userName || ""}
            />
            <AvatarFallback className="bg-zinc-100 text-zinc-600 text-sm">
              {userName?.charAt(0) || "U"}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-56"
        style={{ zIndex: 9999 }}
      >
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium">{userName || "User"}</p>
            <span
              className={`inline-flex w-fit items-center px-2 py-0.5 rounded text-xs font-medium ${getRoleBadgeColor()}`}
            >
              {userRole}
            </span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {profilePath && (
          <DropdownMenuItem asChild>
            <Link href={profilePath} className="cursor-pointer">
              <User className="mr-2 h-4 w-4" />
              Profile
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link href={settingsPath} className="cursor-pointer">
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/" className="cursor-pointer">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Home
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() =>
            signOut({
              fetchOptions: {
                onSuccess: () => {
                  window.location.href = "/auth/signin";
                },
              },
            })
          }
          className="cursor-pointer text-red-600 focus:text-red-600 focus:bg-red-50"
        >
          <LogOut className="mr-2 h-4 w-4" />
          Sign Out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
