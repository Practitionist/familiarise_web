import React from "react";

interface HeaderProps {
  name: string;
  role: string;
}

export function Header({ name, role }: Readonly<HeaderProps>) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-4xl font-bold text-gray-900">Welcome back, {name.split(' ')[0]}</h1>
        <p className="text-gray-700 text-lg">{role}</p>
      </div>
      <div className="flex items-center">
        <p className="text-gray-600">
          Last logged in: <span className="font-medium">Today at 9:45 AM</span>
        </p>
      </div>
    </div>
  );
}
