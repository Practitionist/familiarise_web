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

// Get all slot times from appointment
export const getSlotTimes = (appointment: IAppointment): string[] => {
  return appointment?.slotsOfAppointment?.map(slot => slot.slotStartTimeInUTC) || [];
};

// Get first slot time from appointment (for backwards compatibility)
export const getStartTime = (appointment: IAppointment): string | undefined => {
  const times = getSlotTimes(appointment);
  return times[0];
};

// Check if appointment has any future slots
export const hasUpcomingSlots = (appointment: IAppointment): boolean => {
  const now = new Date();
  return getSlotTimes(appointment).some(time => new Date(time) > now);
};

// Check if appointment has any slots today
export const hasTodaySlots = (appointment: IAppointment): boolean => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  
  return getSlotTimes(appointment).some(time => {
    const date = new Date(time);
    return date >= todayStart && date <= todayEnd;
  });
};

// Format UTC time to local time
export const formatAppointmentTime = (utcTime: string): string => {
  // Create a date object in local time
  const localDate = new Date(utcTime);
  
  // Format the date in local time with browser's timezone
  return format(localDate, "EEE, MMM d, h:mm a");
};

// Get appointment status
export const getAppointmentStatus = (appointment: IAppointment): string => {
  const startTimeStr = getStartTime(appointment);
  if (!startTimeStr) return 'Unknown';
  
  // Convert UTC to local time
  const startTime = new Date(startTimeStr);
  const now = new Date();
  
  // Check if appointment is marked as completed
  if (appointment.class?.status === "COMPLETED" || 
      appointment.webinar?.status === "COMPLETED") {
    return "Completed";
  }

  // Check if all slots are in the past
  if (getSlotTimes(appointment).every(time => new Date(time) < now)) {
    return "Completed";
  }

  // Calculate time differences using local time
  const diffMs = startTime.getTime() - now.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  // Upcoming appointments with more precise timing
  if (diffMinutes <= 5 && diffMinutes > 0) return "Meeting in 5 min";
  if (diffHours < 24) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays < 7) return `In ${diffDays} days`;
  
  // For weekly intervals, show exact week number
  const exactWeeks = Math.ceil(diffDays / 7);
  return `In ${exactWeeks} ${exactWeeks === 1 ? 'week' : 'weeks'}`;
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

  return appointments.filter(appointment => {
    // Check if appointment has any slots today
    if (hasTodaySlots(appointment)) {
      // For subscription appointments, check if they're active
      if (appointment.appointmentType === 'SUBSCRIPTION' && appointment.subscription) {
        const startDate = new Date(appointment.subscription.startDate);
        const endDate = new Date(appointment.subscription.endDate);
        return now >= startDate && now <= endDate;
      }
      
      return true;
    }
    
    return false;
  });
};

// Filter upcoming appointments
export const getUpcomingAppointments = (appointments: IAppointment[]): IAppointment[] => {
  return appointments.filter(appointment => {
    // Check if appointment has any future slots
    if (hasUpcomingSlots(appointment)) {
      // For subscription appointments
      if (appointment.appointmentType === 'SUBSCRIPTION' && appointment.subscription) {
        // Show all appointments with future slots
        return true;
      }
      
      // For class appointments
      if (appointment.appointmentType === 'CLASS' && appointment.class) {
        return appointment.class.status !== "COMPLETED";
      }
      
      // For webinar appointments
      if (appointment.appointmentType === 'WEBINAR' && appointment.webinar) {
        return appointment.webinar.status !== "COMPLETED";
      }
      
      // For consultation appointments
      return true;
    }
    
    return false;
  });
};

// Group recurring appointments
export const groupRecurringAppointments = (appointments: IAppointment[]): { [key: string]: IAppointment[] } => {
  const groups: { [key: string]: IAppointment[] } = {};

  // First, expand appointments with multiple slots into individual appointments
  const expandedAppointments = appointments.flatMap(appointment => {
    if (!appointment.slotsOfAppointment || appointment.slotsOfAppointment.length === 0) {
      return [{
        ...appointment,
        id: `${appointment.id}-default` // Create unique ID for appointments without slots
      }];
    }
    
    // Create separate entries for each slot while maintaining the appointment data
    return appointment.slotsOfAppointment.map(slot => ({
      ...appointment,
      id: `${appointment.id}-${slot.id}`, // Create unique ID combining appointment and slot IDs
      slotsOfAppointment: [slot]
    }));
  });

  // Now group the expanded appointments
  expandedAppointments.forEach(appointment => {
    let groupKey = '';

    if (appointment.appointmentType === 'SUBSCRIPTION' && appointment.subscription) {
      groupKey = `subscription-${appointment.subscription.id}`;
    } else if (appointment.appointmentType === 'CLASS' && appointment.class) {
      groupKey = `class-${appointment.class.id}`;
    } else {
      // For non-recurring appointments, use their own ID as the group key
      groupKey = `single-${appointment.id}`;
    }

    if (!groups[groupKey]) {
      groups[groupKey] = [];
    }
    groups[groupKey].push(appointment);
  });

  // Sort appointments within each group by start time
  Object.keys(groups).forEach(key => {
    groups[key] = sortAppointmentsByStartTime(groups[key]);
  });

  return groups;
};

// Get group title
export const getGroupTitle = (appointments: IAppointment[]): string => {
  if (!appointments.length) return '';

  const firstAppointment = appointments[0];
  const type = firstAppointment.appointmentType;

  if (type === 'SUBSCRIPTION' && firstAppointment.subscription) {
    const plan = firstAppointment.subscription.subscriptionPlan?.title || 'Unknown Plan';
    
    // Use the actual number of appointments as total sessions
    const totalSessions = appointments.length;
    
    // Count completed sessions based on all slots
    const now = new Date();
    const completedSessions = appointments.filter(app => 
      getSlotTimes(app).every(time => new Date(time) < now)
    ).length;

    return `${plan} (${completedSessions}/${totalSessions} sessions)`;
  }

  if (type === 'CLASS' && firstAppointment.class) {
    const plan = firstAppointment.class.classPlan?.title || 'Unknown Class';
    const totalSessions = appointments.length;
    const completedSessions = appointments.filter(app => app.class?.status === 'COMPLETED').length;

    return `${plan} (${completedSessions}/${totalSessions} sessions)`;
  }

  return getAppointmentTypeAndPlan(firstAppointment);
};

// Get group status
export const getGroupStatus = (appointments: IAppointment[]): string => {
  if (!appointments.length) return 'Unknown';

  const firstAppointment = appointments[0];
  const type = firstAppointment.appointmentType;

  if (type === 'SUBSCRIPTION' && firstAppointment.subscription) {
    const now = new Date();
    const startDate = new Date(firstAppointment.subscription.startDate);
    const endDate = new Date(firstAppointment.subscription.endDate);

    // Check if any sessions are completed (all slots in the past)
    const hasCompletedSessions = appointments.some(app => 
      getSlotTimes(app).every(time => new Date(time) < now)
    );

    if (now > endDate) return 'Completed';
    if (now < startDate) return 'Not Started';
    return hasCompletedSessions ? 'In Progress' : 'Not Started';
  }

  if (type === 'CLASS' && firstAppointment.class) {
    if (firstAppointment.class.status === 'COMPLETED') return 'Completed';
    if (firstAppointment.class.status === 'IN_PROGRESS') return 'In Progress';
    return 'Not Started';
  }

  return getAppointmentStatus(firstAppointment);
};
