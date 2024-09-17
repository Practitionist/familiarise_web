import React from 'react';
import { Button } from "@/components/ui/button";

interface SidebarProps {
  activeSection: string;
  setActiveSection: (section: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ activeSection, setActiveSection }) => (
  <aside className="col-span-2">
    <nav className="space-y-1">
      {['Home', 'Chats', 'Appointments', 'Requests', 'Documents for Review', 'Help'].map((item) => (
        <button
          key={item}
          className={`block w-full text-left p-3 rounded-lg ${activeSection === item ? 'bg-blue-500 text-white' : 'text-gray-600 hover:bg-gray-200'}`}
          onClick={() => setActiveSection(item)}
        >
          {item}
        </button>
      ))}
    </nav>
    <div className="mt-6 p-4 bg-white rounded-lg shadow">
      <h2 className="text-lg font-semibold mb-2">Upgrade Now</h2>
      <p className="text-sm text-gray-600 mb-4">Find out what an improved account offers</p>
      <Button className="bg-blue-500 text-white">Explore Plans</Button>
    </div>
  </aside>
);