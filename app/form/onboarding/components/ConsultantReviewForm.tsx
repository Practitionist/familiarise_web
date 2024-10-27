import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConsultantProfile, PersonalInfoAndRole } from "@/schemas/UserSchema";

interface Props {
  onSubmit: (data: FormData) => void;
  onBack: () => void;
  formData: FormData;
}

type FormData = PersonalInfoAndRole & 
  Partial<ConsultantProfile> & {
    termsAccepted?: boolean;
    privacyAccepted?: boolean;
  };

const ConsultantReviewForm: React.FC<Props> = ({ onSubmit, onBack, formData }) => {
  const handleSubmit = () => {
    onSubmit(formData);
  };

  const formatTime = (timeString: string) => {
    try {
      // If timeString is already in HH:mm format, format it to 12-hour time
      if (/^\d{2}:\d{2}$/.test(timeString)) {
        const [hours, minutes] = timeString.split(':').map(Number);
        const date = new Date();
        date.setHours(hours, minutes, 0, 0);
        return date.toLocaleTimeString('en-US', { 
          hour: 'numeric',
          minute: '2-digit',
          hour12: true 
        });
      }

      // If timeString is a full ISO date string, extract and format the time part
      if (timeString.includes('T')) {
        const date = new Date(timeString);
        if (isNaN(date.getTime())) {
          return timeString; // Return original if date is invalid
        }
        return date.toLocaleTimeString('en-US', { 
          hour: 'numeric',
          minute: '2-digit',
          hour12: true 
        });
      }

      // Return original string if we can't parse it
      return timeString;
    } catch (error) {
      console.error('Error formatting time:', error);
      return timeString;
    }
  };

  const formatDay = (day: string) => {
    return day.charAt(0) + day.slice(1).toLowerCase();
  };

  const renderSchedule = () => {
    if (formData.scheduleType === "WEEKLY") {
      // Group slots by day for better organization
      const slotsByDay = formData.weeklySlots?.reduce((acc, slot) => {
        const day = slot.dayOfWeekforStartTimeInUTC;
        if (!acc[day]) acc[day] = [];
        acc[day].push(slot);
        return acc;
      }, {} as Record<string, typeof formData.weeklySlots>);

      return (
        <div>
          <h4 className="font-semibold">Weekly Schedule:</h4>
          {Object.entries(slotsByDay || {}).map(([day, slots]) => (
            <div key={`weekly-${day}`} className="mb-2">
              <p className="font-medium">{formatDay(day)}:</p>
              {slots?.map((slot, index) => (
                <p key={`weekly-${day}-${index}`} className="ml-4">
                  {formatTime(slot.slotStartTimeInUTC)} - {formatTime(slot.slotEndTimeInUTC)}
                </p>
              ))}
            </div>
          ))}
        </div>
      );
    } else if (formData.scheduleType === "CUSTOM") {
      // Group slots by date for better organization
      const slotsByDate = formData.customSlots?.reduce((acc, slot) => {
        try {
          const date = new Date(slot.slotStartTimeInUTC);
          if (isNaN(date.getTime())) {
            return acc;
          }
          const dateString = date.toISOString().split('T')[0];
          if (!acc[dateString]) acc[dateString] = [];
          acc[dateString].push(slot);
        } catch (error) {
          console.error('Error processing slot:', error);
        }
        return acc;
      }, {} as Record<string, typeof formData.customSlots>);

      return (
        <div>
          <h4 className="font-semibold">Custom Schedule:</h4>
          {Object.entries(slotsByDate || {}).map(([date, slots]) => (
            <div key={`custom-${date}`} className="mb-2">
              <p className="font-medium">{new Date(date).toLocaleDateString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric'
              })}:</p>
              {slots?.map((slot, index) => (
                <p key={`custom-${date}-${index}`} className="ml-4">
                  {formatTime(slot.slotStartTimeInUTC)} - {formatTime(slot.slotEndTimeInUTC)}
                </p>
              ))}
            </div>
          ))}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="w-full max-w-md space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Review Your Information</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <h3 className="font-semibold">Personal Information</h3>
            <p>Name: {formData.name}</p>
            <p>Email: {formData.email}</p>
            <p>Phone: {formData.phone}</p>
            <p>Address: {formData.address}</p>
          </div>
          <div>
            <h3 className="font-semibold">Consultant Profile</h3>
            <p>Description: {formData.description}</p>
            <p>Qualifications: {formData.qualifications}</p>
            <p>Specialization: {formData.specialization}</p>
            <p>Experience: {formData.experience}</p>
            <p>Domain: {formData.domain?.name}</p>
            <p>Sub-Domains: {formData.subDomains?.map(sd => sd.name).join(", ")}</p>
            <p>Tags: {formData.tags?.map(t => t.name).join(", ")}</p>
          </div>
          <div>
            <h3 className="font-semibold">Preferred Schedule</h3>
            <p>Schedule Type: {formData.scheduleType}</p>
            {renderSchedule()}
          </div>
        </CardContent>
      </Card>
      <div className="flex justify-between">
        <Button type="button" onClick={onBack} variant="outline">
          Back
        </Button>
        <Button type="button" onClick={handleSubmit} variant="night">
          Submit
        </Button>
      </div>
    </div>
  );
};

export default ConsultantReviewForm;
