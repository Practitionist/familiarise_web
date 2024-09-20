"use client";

import { BellIcon } from "@/assets/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from 'react';
import AppointmentsTab from './components/AppointmentsTab';
import BookingHistoryTab from './components/BookingHistoryTab';
import FeedbackSupportTab from './components/FeedbackSupportTab';
import HomeTab from './components/HomeTab';
import MessagesTab from './components/MessagesTab';
import PolicyTab from './components/PolicyTab';

const tabs = ['Home', 'Appointments', 'Messages', 'Feedback & Support', 'Booking History', 'Policy'];

export default function ConsulteeDashboard() {
  const [activeTab, setActiveTab] = useState('Home');

  return (
    <div className="bg-gray-100 min-h-screen flex flex-col">
      <div className="p-8 pt-32">
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center space-x-4 overflow-x-auto">
            {tabs.map((tab) => (
              <Button
                key={tab}
                className={`${
                  activeTab === tab
                    ? 'bg-[#f87171] text-white'
                    : 'text-gray-500 hover:bg-gray-200'
                } rounded-md px-4 py-2 transition-colors whitespace-nowrap`}
                variant={activeTab === tab ? 'default' : 'ghost'}
                onClick={() => setActiveTab(tab)}
              >
                {tab}
              </Button>
            ))}
          </div>
          <div className="flex items-center space-x-4">
            <Input
              placeholder="Search here..."
              className="rounded-md px-4 py-2 border border-gray-300 focus:outline-none focus:ring-2 focus:ring-[#f87171] focus:border-transparent"
            />
            <BellIcon className="h-6 w-6 text-gray-500 hover:text-gray-700 cursor-pointer" />
          </div>
        </div>
      </div>
      <div className="flex-grow overflow-y-auto p-8">
        {activeTab === 'Home' && <HomeTab />}
        {activeTab === 'Appointments' && <AppointmentsTab />}
        {activeTab === 'Messages' && <MessagesTab />}
        {activeTab === 'Feedback & Support' && <FeedbackSupportTab />}
        {activeTab === 'Booking History' && <BookingHistoryTab />}
        {activeTab === 'Policy' && <PolicyTab />}
      </div>
    </div>
  )
}