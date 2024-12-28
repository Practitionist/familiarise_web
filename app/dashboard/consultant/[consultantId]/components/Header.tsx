import React from "react";
import { Menu } from "lucide-react";

interface HeaderProps {
  name: string;
  role: string;
  onMenuClick?: () => void;
}

export function Header({ name, role, onMenuClick }: Readonly<HeaderProps>) {
  return (
    <div className="flex items-center justify-between bg-white px-4 py-3 lg:p-0 lg:bg-transparent rounded-lg lg:rounded-none shadow-sm lg:shadow-none">
      <div className="flex items-center gap-3 lg:gap-4">
        <button
          onClick={onMenuClick}
          className="lg:hidden p-2 hover:bg-gray-100 active:bg-gray-200 rounded-lg transition-colors"
          aria-label="Toggle menu"
          type="button"
        >
          <Menu className="h-6 w-6 text-gray-700" />
        </button>
        <div>
          <h1 className="text-xl sm:text-2xl lg:text-4xl font-bold text-gray-900">
            Welcome back, {name.split(" ")[0]}
          </h1>
          <p className="text-gray-700 text-sm sm:text-base lg:text-lg">
            {role}
          </p>
        </div>
      </div>
      <div className="hidden sm:flex items-center">
        <p className="text-sm sm:text-base text-gray-600">
          Last logged in: <span className="font-medium">Today at 9:45 AM</span>
        </p>
      </div>
    </div>
  );
}
