import React from 'react';
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { SearchIcon, SettingsIcon, SignalIcon } from '@/assets/icons';

interface HeaderProps {
  name: string;
  role: string;
}

export const Header: React.FC<HeaderProps> = ({ name, role }) => (
  <header className="flex items-center justify-between pb-6">
    <div className="flex items-center">
      <div className="mr-6">
        <Avatar>
          <AvatarImage alt={name} src="/placeholder.svg" />
          <AvatarFallback>{name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
        </Avatar>
      </div>
      <div>
        <h1 className="text-2xl font-semibold">{name}</h1>
        <p className="text-sm text-gray-500">{role}</p>
      </div>
    </div>
    <div className="flex space-x-4">
      <SettingsIcon className="text-gray-500" />
      <SignalIcon className="text-gray-500" />
      <SearchIcon className="text-gray-500" />
    </div>
  </header>
);