import React from "react";
import { Consultant } from "../types";

type HeaderProps = Pick<Consultant, "name" | "role">;

export function Header({ name, role }: Readonly<HeaderProps>) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-4xl font-bold text-gray-900">Hello {name}</h1>
        <p className="text-gray-700 text-lg">{role}</p>
      </div>
      <div className="flex items-center space-x-4">
        <button className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors">
          Edit Profile
        </button>
        <button className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors">
          Settings
        </button>
      </div>
    </div>
  );
}
