import React from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { ScheduleType } from "@prisma/client";

export function SettingsTab() {
  return (
    <div className="bg-white p-6 rounded-lg shadow space-y-8">
      {/* Professional Profile */}
      <div>
        <h2 className="text-xl font-semibold mb-2">Professional Profile</h2>
        <p className="text-sm text-gray-500 mb-6">
          Update your professional information and expertise
        </p>

        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-4">
            <div>
              <Label>Qualifications</Label>
              <Textarea placeholder="Your professional qualifications" />
            </div>
            <div>
              <Label>Specialization</Label>
              <Input placeholder="Your area of expertise" />
            </div>
            <div>
              <Label>Experience (years)</Label>
              <Input
                type="number"
                placeholder="Years of professional experience"
              />
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <Label>Domain</Label>
              <Select>
                <SelectTrigger>
                  <SelectValue placeholder="Select your primary domain" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="technology">Technology</SelectItem>
                  <SelectItem value="business">Business</SelectItem>
                  <SelectItem value="healthcare">Healthcare</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Sub-domains</Label>
              <Select>
                <SelectTrigger>
                  <SelectValue placeholder="Select sub-domains" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="web">Web Development</SelectItem>
                  <SelectItem value="mobile">Mobile Development</SelectItem>
                  <SelectItem value="ai">AI & Machine Learning</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Professional Description</Label>
              <Textarea placeholder="Describe your professional background and expertise" />
            </div>
          </div>
        </div>
      </div>

      <Separator />

      {/* Availability Settings */}
      <div>
        <h2 className="text-xl font-semibold mb-2">Availability Settings</h2>
        <p className="text-sm text-gray-500 mb-6">
          Configure your availability and scheduling preferences
        </p>

        <Card className="p-6 space-y-6">
          <div>
            <Label>Schedule Type</Label>
            <Select>
              <SelectTrigger>
                <SelectValue placeholder="Select schedule type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ScheduleType.WEEKLY}>
                  Weekly Recurring
                </SelectItem>
                <SelectItem value={ScheduleType.CUSTOM}>
                  Custom Dates
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Preferred Session Duration (hours)</Label>
            <Select>
              <SelectTrigger>
                <SelectValue placeholder="Select default duration" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0.5">30 minutes</SelectItem>
                <SelectItem value="1">1 hour</SelectItem>
                <SelectItem value="1.5">1.5 hours</SelectItem>
                <SelectItem value="2">2 hours</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </Card>
      </div>

      <Separator />

      {/* Service Settings */}
      <div>
        <h2 className="text-xl font-semibold mb-2">Service Configuration</h2>
        <p className="text-sm text-gray-500 mb-6">
          Manage your service offerings and preferences
        </p>

        <div className="space-y-6">
          <Card className="p-6">
            <h3 className="font-medium mb-4">Default Service Settings</h3>
            <div className="space-y-4">
              <div>
                <Label>Default Language</Label>
                <Input placeholder="e.g., English" />
              </div>
              <div>
                <Label>Default Level</Label>
                <Select>
                  <SelectTrigger>
                    <SelectValue placeholder="Select default level" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="beginner">Beginner</SelectItem>
                    <SelectItem value="intermediate">Intermediate</SelectItem>
                    <SelectItem value="advanced">Advanced</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Prerequisites Template</Label>
                <Textarea placeholder="Default prerequisites for your services" />
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex justify-end space-x-4 pt-6">
        <Button variant="outline">Cancel</Button>
        <Button>Save Changes</Button>
      </div>
    </div>
  );
}
