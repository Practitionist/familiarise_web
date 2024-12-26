"use client";

import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export function Advertisement() {
  return (
    <Card className="bg-gradient-to-br from-purple-50 to-indigo-50 border-none h-full shadow-lg">
      <CardHeader className="pb-4">
        <CardTitle className="text-xl font-bold text-indigo-900">
          Unlock Premium Features
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          <div className="space-y-4">
            <ul className="space-y-3">
              <li className="flex items-center text-indigo-700">
                <svg
                  className="h-5 w-5 mr-3 text-indigo-500 flex-shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                <span className="text-sm">Unlimited Access to Expert Sessions</span>
              </li>
              <li className="flex items-center text-indigo-700">
                <svg
                  className="h-5 w-5 mr-3 text-indigo-500 flex-shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                <span className="text-sm">24/7 Priority Support</span>
              </li>
              <li className="flex items-center text-indigo-700">
                <svg
                  className="h-5 w-5 mr-3 text-indigo-500 flex-shrink-0"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                <span className="text-sm">Exclusive Webinars & Workshops</span>
              </li>
            </ul>
          </div>
          
          <div className="pt-4 border-t border-indigo-100">
            <div className="flex items-baseline mb-1">
              <span className="text-3xl font-bold text-indigo-900">$99</span>
              <span className="text-indigo-700 ml-2 text-sm">/month</span>
            </div>
            <p className="text-xs text-indigo-600 mb-4">
              Save 20% with annual billing
            </p>
            <Button 
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm"
              onClick={() => console.log('Upgrade clicked')}
            >
              Upgrade Now
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
