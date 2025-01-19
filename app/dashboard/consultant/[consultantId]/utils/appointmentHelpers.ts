import { format } from "date-fns";
import { IAppointment } from "../types";

// Get the consultee name based on appointment type
export const getConsumeeName = (appointment: IAppointment): string => {
  if (!appointment) return 'Unknown User';
  
  switch (appointment.appointmentType) {
    case 'CONSULTATION':
      return appointment.consultation?.requestedBy?.user?.name || 'Unknown User';
    case 'SUBSCRIPTION':
      return appointment.subscription?.requestedBy?.user?.name || 'Unknown User';
    case 'WEBINAR':
    case 'CLASS':
      return appointment.slotsOfAppointment?.[0]?.user?.[0]?.name || 'Unknown User';
    default:
      return 'Unknown User';
  }
};

// Get the consultee image based on appointment type
export const getConsumeeImage = (appointment: IAppointment): string => {
  if (!appointment) return '/placeholder.svg';
  
  switch (appointment.appointmentType) {
    case 'CONSULTATION':
      return appointment.consultation?.requestedBy?.user?.image || '/placeholder.svg';
    case 'SUBSCRIPTION':
      return appointment.subscription?.requestedBy?.user?.image || '/placeholder.svg';
    case 'WEBINAR':
    case 'CLASS':
      return appointment.slotsOfAppointment?.[0]?.user?.[0]?.image || '/placeholder.svg';
    default:
      return '/placeholder.svg';
  }
};

// Get appointment type and plan
export const getAppointmentTypeAndPlan = (appointment: IAppointment): string => {
  if (!appointment?.appointmentType) return 'Unknown Type';
  
  const type = appointment.appointmentType.charAt(0) + 
              appointment.appointmentType.slice(1).toLowerCase();
  let plan = "Unknown Plan";
  
  switch (appointment.appointmentType) {
    case 'CONSULTATION':
      plan = appointment.consultation?.consultationPlan?.title || 'Unknown Plan';
      break;
    case 'SUBSCRIPTION':
      plan = appointment.subscription?.subscriptionPlan?.title || 'Unknown Plan';
      break;
    case 'WEBINAR':
      plan = appointment.webinar?.webinarPlan?.title || 'Unknown Plan';
      break;
    case 'CLASS':
      plan = appointment.class?.classPlan?.title || 'Unknown Plan';
      break;
  }
  
  return `${type} - ${plan}`;
};

// Get start time from appointment
export const getStartTime = (appointment: IAppointment): string | undefined => {
  return appointment?.slotsOfAppointment?.[0]?.slotStartTimeInUTC;
};

// Format UTC time to local time
export const formatAppointmentTime = (utcTime: string): string => {
  const localDate = new Date(utcTime);
  return format(localDate, "EEE, MMM d, h:mm a");
};

// Get appointment status
export const getAppointmentStatus = (appointment: IAppointment): string => {
  const startTimeStr = getStartTime(appointment);
  if (!startTimeStr) return 'Unknown';
  
  const startTime = new Date(startTimeStr);
  const now = new Date();
  
  // Check if appointment is marked as completed
  if (appointment.class?.status === "COMPLETED" || 
      appointment.webinar?.status === "COMPLETED") {
    return "Completed";
  }

  // For subscription appointments, check subscription status
  if (appointment.appointmentType === 'SUBSCRIPTION' && appointment.subscription) {
    const endDate = new Date(appointment.subscription.endDate);
    const startDate = new Date(appointment.subscription.startDate);

    // If subscription hasn't started yet
    if (now < startDate) {
      const diffInDays = Math.floor((startDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      if (diffInDays <= 1) return "Tomorrow";
      if (diffInDays <= 7) return `In ${diffInDays} days`;
      if (diffInDays <= 30) return `In ${Math.floor(diffInDays / 7)} weeks`;
      return `In ${Math.floor(diffInDays / 30)} months`;
    }

    // If subscription has ended
    if (now > endDate) {
      return "Completed";
    }

    // If subscription is active
    const diffInMinutes = Math.floor((startTime.getTime() - now.getTime()) / (1000 * 60));
    if (diffInMinutes <= 5) return "Meeting in 5 min";
    if (diffInMinutes <= 0) return "Today";
    return "Today";
  }

  // For other appointment types
  if (startTime < now) {
    return "Completed";
  }
  
  const diffInMinutes = Math.floor((startTime.getTime() - now.getTime()) / (1000 * 60));
  const diffInHours = Math.floor(diffInMinutes / 60);
  const diffInDays = Math.floor(diffInHours / 24);
  
  // Upcoming appointments
  if (diffInMinutes <= 5) return "Meeting in 5 min";
  if (diffInHours === 0) return "Today";
  if (diffInDays === 0) return "Today";
  if (diffInDays === 1) return "Tomorrow";
  if (diffInDays <= 7) return `In ${diffInDays} days`;
  if (diffInDays <= 30) return `In ${Math.floor(diffInDays / 7)} weeks`;
  return `In ${Math.floor(diffInDays / 30)} months`;
};

// Sort appointments by start time
export const sortAppointmentsByStartTime = (appointments: IAppointment[]): IAppointment[] => {
  return [...appointments].sort((a, b) => {
    const aTime = getStartTime(a);
    const bTime = getStartTime(b);
    if (!aTime || !bTime) return 0;
    return new Date(aTime).getTime() - new Date(bTime).getTime();
  });
};

// Filter today's appointments
export const getTodayAppointments = (appointments: IAppointment[]): IAppointment[] => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  return appointments.filter(appointment => {
    const startTime = getStartTime(appointment);
    if (!startTime) return false;

    // For subscription appointments, check if they're active today
    if (appointment.appointmentType === 'SUBSCRIPTION' && appointment.subscription) {
      const startDate = new Date(appointment.subscription.startDate);
      const endDate = new Date(appointment.subscription.endDate);
      const appointmentDate = new Date(startTime);
      return appointmentDate >= todayStart && appointmentDate <= todayEnd && now >= startDate && now <= endDate;
    }

    // For other appointments
    const appointmentDate = new Date(startTime);
    return appointmentDate >= todayStart && appointmentDate <= todayEnd;
  });
};

// Filter upcoming appointments
export const getUpcomingAppointments = (appointments: IAppointment[]): IAppointment[] => {
  const now = new Date();
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

  return appointments.filter(appointment => {
    const startTime = getStartTime(appointment);
    if (!startTime) return false;
    
    const appointmentDate = new Date(startTime);
    
    // For subscription appointments, check if they're still active
    if (appointment.appointmentType === 'SUBSCRIPTION' && appointment.subscription) {
      const startDate = new Date(appointment.subscription.startDate);
      const endDate = new Date(appointment.subscription.endDate);
      return appointmentDate > todayEnd && now <= endDate && appointmentDate >= startDate;
    }
    
    return appointmentDate > todayEnd;
  });
};
