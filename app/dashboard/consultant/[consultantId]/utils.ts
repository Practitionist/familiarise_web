export interface Consultant {
  name: string;
  role: string;
  description?: string | null;
  qualifications?: string | null;
  specialization?: string | null;
  experience?: string | null;
  rating: number;
}

export interface Appointment {
  id: string;
  name: string;
  description: string;
  time: string;
  badge: string;
}

export interface Document {
  id: string;
  invoiceNo: string;
  clientName: string;
  title: string;
  tag: string;
}

export interface Activity {
  id: string;
  name: string;
  action: string;
  time: string;
}

export interface Approval {
  id: string;
  name: string;
  type: string;
  date: string;
  time: string;
}

function getSessionType(appointment: any): string {
  if (!appointment) return 'Unknown Session Type';
  
  if (appointment.consultation?.consultationPlan) {
    return 'Basic Consultation';
  }
  
  if (appointment.subscription?.plan) {
    return 'Extended Consultation';
  }
  
  if (appointment.webinar?.webinarPlan) {
    return appointment.webinar.webinarPlan.title || 'Webinar Session';
  }
  
  if (appointment.class?.classPlan) {
    return appointment.class.classPlan.title || 'Class Session';
  }
  
  return 'Unknown Session Type';
}

function getClientName(appointment: any): string {
  try {
    // First try to get the consultee's name
    const consultee = appointment.slotOfAppointment?.[0]?.consulteeProfile?.user;
    if (consultee?.name) {
      return consultee.name;
    }

    // If no consultee name, try consultation requestedBy
    if (appointment.consultation?.requestedBy?.user?.name) {
      return appointment.consultation.requestedBy.user.name;
    }

    // If no consultation name, try subscription requestedBy
    if (appointment.subscription?.requestedBy?.user?.name) {
      return appointment.subscription.requestedBy.user.name;
    }

    // If no name found anywhere, return Anonymous
    return 'Anonymous';
  } catch (error) {
    console.error('Error getting client name:', error);
    return 'Anonymous';
  }
}



function getBadgeText(startTimeUTC: string): string {
  const now = new Date();
  const startTimeLocal = new Date(startTimeUTC);
  const diffInMinutes = Math.floor((startTimeLocal.getTime() - now.getTime()) / (1000 * 60));
  const diffInDays = Math.floor(diffInMinutes / (24 * 60));
  const diffInWeeks = Math.floor(diffInDays / 7);
  const diffInMonths = Math.floor(diffInDays / 30.44); // Average days in a month
  const diffInYears = Math.floor(diffInDays / 365.25); // Account for leap years
  
  // Log time calculations for debugging
  console.log('Badge time debug:', {
    nowUTC: now.toISOString(),
    startTimeUTC,
    nowLocal: now.toLocaleString(),
    startTimeLocal: startTimeLocal.toLocaleString(),
    calculations: {
      diffInMinutes,
      diffInHours: Math.floor(diffInMinutes / 60),
      diffInDays,
      diffInWeeks,
      diffInMonths,
      diffInYears
    }
  });

  // If the meeting is in the past
  if (diffInMinutes < -30) {
    return 'Completed';
  }

  // If the meeting is happening now or within the next 5 minutes
  if (diffInMinutes >= -5 && diffInMinutes <= 5) {
    return 'Meeting in 5 min';
  }

  // If the meeting is within the next 2 hours
  if (diffInMinutes > 5 && diffInMinutes <= 120) {
    return 'Meeting in 2 hours';
  }

  // Check if it's tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const dayAfterTomorrow = new Date(tomorrow);
  dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);

  // If it's tomorrow
  if (startTimeLocal >= tomorrow && startTimeLocal < dayAfterTomorrow) {
    return 'Tomorrow';
  }

  // If it's beyond tomorrow
  if (diffInYears > 0) {
    const years = Math.floor(diffInYears);
    return `In ${years} ${years === 1 ? 'year' : 'years'}`;
  }

  if (diffInMonths > 0) {
    const months = Math.floor(diffInMonths);
    return `In ${months} ${months === 1 ? 'month' : 'months'}`;
  }

  if (diffInWeeks > 0) {
    const weeks = Math.floor(diffInWeeks);
    return `In ${weeks} ${weeks === 1 ? 'week' : 'weeks'}`;
  }

  const days = Math.floor(diffInDays);
  return `In ${days} ${days === 1 ? 'day' : 'days'}`;
}

function formatTimeRange(startTime: Date, endTime: Date): string {
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).replace(':00', ''); // Remove seconds if present
  };

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });
  };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  // Convert UTC dates to local
  const startTimeLocal = new Date(startTime);
  const endTimeLocal = new Date(endTime);

  // Log time formatting for debugging
  console.log('Time format debug:', {
    input: {
      startUTC: startTime.toISOString(),
      endUTC: endTime.toISOString(),
      startLocal: startTimeLocal.toLocaleString(),
      endLocal: endTimeLocal.toLocaleString()
    },
    reference: {
      today: today.toLocaleString(),
      tomorrow: tomorrow.toLocaleString(),
      currentTime: new Date().toLocaleString()
    }
  });

  // Format date part
  let dateStr = '';
  if (startTimeLocal >= today && startTimeLocal < tomorrow) {
    // Today - no date needed
  } else {
    dateStr = formatDate(startTimeLocal) + ', ';
  }

  return `${dateStr}${formatTime(startTimeLocal)} - ${formatTime(endTimeLocal)}`;
}


export async function fetchConsultantData(id: string): Promise<Consultant> {
  const response = await fetch(`/api/user/consultants/${id}`);
  if (!response.ok) {
    throw new Error("Failed to fetch consultant data");
  }
  const { data } = await response.json();
  
  return {
    name: data.user.name || "Anonymous",
    role: "CONSULTANT",
    description: data.description,
    qualifications: data.qualifications,
    specialization: data.specialization,
    experience: data.experience,
    rating: data.rating,
  };
}

export async function fetchAppointments(consultantId: string): Promise<Appointment[]> {
  const response = await fetch(`/api/slots/appointments?consultantProfileId=${consultantId}`);
  if (!response.ok) {
    throw new Error("Failed to fetch appointments");
  }
  const { data } = await response.json();
  
  if (!Array.isArray(data)) {
    console.error('Expected array of appointments, got:', data);
    return [];
  }

  return data.map((appointment: any) => {
    try {
      const slot = appointment.slotOfAppointment?.[0];
      if (!slot) {
        throw new Error('No slot data available');
      }

      // Parse dates and ensure they're in the correct timezone
      const startTime = new Date(slot.slotStartTimeInUTC);
      const endTime = new Date(slot.slotEndTimeInUTC);
      
      if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
        throw new Error('Invalid date values');
      }

      // Get client name from the appropriate source
      let name = 'Anonymous';
      let description = 'Unknown Session Type';

      if (appointment.consultation) {
        name = appointment.consultation.requestedBy?.user?.name || 'Anonymous';
        description = appointment.consultation.consultationPlan?.title || 'Basic Consultation';
      } else if (appointment.subscription) {
        name = appointment.subscription.requestedBy?.user?.name || 'Anonymous';
        description = appointment.subscription.plan?.title || 'Extended Consultation';
      } else if (appointment.webinar) {
        name = slot.consulteeProfile?.user?.name || 'Anonymous';
        description = appointment.webinar.webinarPlan?.title || 'Webinar Session';
      } else if (appointment.class) {
        name = slot.consulteeProfile?.user?.name || 'Anonymous';
        description = appointment.class.classPlan?.title || 'Class Session';
      }

      // Log appointment details for debugging
      console.log('Appointment debug:', {
        id: appointment.id,
        type: appointment.appointmentType,
        name,
        description,
        timing: {
          startUTC: startTime.toISOString(),
          endUTC: endTime.toISOString(),
          startLocal: startTime.toLocaleString(),
          endLocal: endTime.toLocaleString()
        },
        users: {
          consultee: slot.consulteeProfile?.user?.name,
          requestedBy: appointment.consultation?.requestedBy?.user?.name || 
                      appointment.subscription?.requestedBy?.user?.name,
          consultant: appointment.consultation?.consultationPlan?.consultantProfile?.user?.name ||
                     appointment.subscription?.plan?.consultantProfile?.user?.name ||
                     appointment.webinar?.webinarPlan?.consultantProfile?.user?.name ||
                     appointment.class?.classPlan?.consultantProfile?.user?.name
        }
      });

      const timeRange = formatTimeRange(startTime, endTime);
      const badge = getBadgeText(startTime.toISOString()); // Convert Date to ISO string

      return {
        id: appointment.id,
        name,
        description,
        time: timeRange,
        badge
      };
    } catch (error) {
      console.error('Error processing appointment:', error);
      console.error('Problematic appointment data:', appointment);
      return {
        id: appointment.id || 'unknown',
        name: 'Anonymous',
        description: 'Unknown Session Type',
        time: 'Time not available',
        badge: 'Schedule unavailable'
      };
    }
  }).filter(Boolean).sort((a, b) => {
    // Sort by time, assuming the time string starts with the date when it's not today
    const aTime = a.time.includes(',') ? a.time : `Today, ${a.time}`;
    const bTime = b.time.includes(',') ? b.time : `Today, ${b.time}`;
    return aTime.localeCompare(bTime);
  });
}

export async function fetchDocuments(id: string): Promise<Document[]> {
  // For now returning mock data as there's no document review system in schema yet
  return [
    {
      id: "1",
      invoiceNo: "2150",
      clientName: "Andrea Jennings",
      title: "2020 - Tax Statement",
      tag: "2023",
    },
    {
      id: "2",
      invoiceNo: "2151",
      clientName: "Stacey Larson",
      title: "2021 - Tax Statement",
      tag: "2023",
    },
    {
      id: "3",
      invoiceNo: "2152",
      clientName: "Yvonne Breiner",
      title: "2022 - Tax Statement",
      tag: "2023",
    },
    {
      id: "4",
      invoiceNo: "2153",
      clientName: "Steven Glover",
      title: "2023 - Tax Statement",
      tag: "2023",
    },
  ];
}

export async function fetchActivities(id: string): Promise<Activity[]> {
  // For now returning mock data as there's no activity tracking in schema yet
  return [
    {
      id: "1",
      name: "Stephen",
      action: "Stephen joined to 🎨 channel.",
      time: "20m ago",
    },
    {
      id: "2",
      name: "Alice",
      action: "Alice uploaded a new document.",
      time: "1h ago",
    },
    {
      id: "3",
      name: "Bob",
      action: "Bob scheduled a meeting.",
      time: "2h ago",
    },
  ];
}

export async function fetchApprovals(id: string): Promise<Approval[]> {
  // Fetch both consultation and subscription requests
  const [consultationsRes, subscriptionsRes] = await Promise.all([
    fetch(`/api/events/consultations?consultantId=${id}&status=PENDING`),
    fetch(`/api/events/subscriptions?consultantId=${id}&status=PENDING`)
  ]);

  if (!consultationsRes.ok || !subscriptionsRes.ok) {
    throw new Error("Failed to fetch approvals");
  }

  const { data: consultations } = await consultationsRes.json();
  const { data: subscriptions } = await subscriptionsRes.json();

  const approvals = [
    ...(consultations || []).map((consultation: any) => ({
      id: consultation.id,
      name: consultation.requestedBy?.user?.name || 'Anonymous',
      type: 'Consultation',
      date: new Date(consultation.requestedAt).toLocaleDateString(),
      time: new Date(consultation.requestedAt).toLocaleTimeString()
    })),
    ...(subscriptions || []).map((subscription: any) => ({
      id: subscription.id,
      name: subscription.requestedBy?.user?.name || 'Anonymous',
      type: 'Subscription',
      date: new Date(subscription.requestedAt).toLocaleDateString(),
      time: new Date(subscription.requestedAt).toLocaleTimeString()
    }))
  ];

  return approvals.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export async function updateApprovalStatus(
  consultantId: string, 
  approvalId: string, 
  status: 'APPROVED' | 'REJECTED',
  type: 'consultation' | 'subscription'
) {
  const endpoint = type === 'consultation' 
    ? `/api/events/consultations/${approvalId}`
    : `/api/events/subscriptions/${approvalId}`;

  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status }),
  });

  if (!response.ok) {
    throw new Error(`Failed to update ${type} status`);
  }

  const { data } = await response.json();
  return data;
}

