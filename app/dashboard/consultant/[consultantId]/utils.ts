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

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).replace(':00', ''); // Remove seconds if present
}

function getSessionType(appointment: any): string {
  if (!appointment) return 'Unknown Session Type';
  
  if (appointment.consultation?.consultationPlan) {
    return appointment.consultation.consultationPlan.title || 'Basic Consultation';
  }
  
  if (appointment.subscription?.plan) {
    return appointment.subscription.plan.title || 'Extended Consultation';
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
  const consultee = appointment.slotOfAppointment?.[0]?.consulteeProfile;
  if (consultee?.user?.name) {
    return consultee.user.name;
  }
  return 'Anonymous';
}

function getBadgeText(startTime: Date): string {
  const now = new Date();
  const diffInMinutes = Math.floor((startTime.getTime() - now.getTime()) / (1000 * 60));
  
  if (diffInMinutes <= 5 && diffInMinutes > -30) { // Include recently started meetings
    return 'Meeting in 5 min';
  }
  
  if (diffInMinutes <= 120) {
    return 'Meeting in 2 hours';
  }
  
  if (startTime.getDate() === now.getDate() + 1) {
    return 'Tomorrow';
  }
  
  return 'Next Week';
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

      const startTime = new Date(slot.slotStartTimeInUTC);
      const endTime = new Date(slot.slotEndTimeInUTC);
      
      if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
        throw new Error('Invalid date values');
      }

      const name = getClientName(appointment);
      const description = getSessionType(appointment);
      const timeRange = `${formatTime(startTime)} - ${formatTime(endTime)}`;
      const badge = getBadgeText(startTime);

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
  }).filter(Boolean);
}

export async function fetchDocuments(id: string): Promise<Document[]> {
  // For now returning mock data as there's no document review system in schema yet
  return [
    {
      invoiceNo: "2150",
      clientName: "Andrea Jennings",
      title: "2020 - Tax Statement",
      tag: "2023",
    },
    {
      invoiceNo: "2151",
      clientName: "Stacey Larson",
      title: "2021 - Tax Statement",
      tag: "2023",
    },
    {
      invoiceNo: "2152",
      clientName: "Yvonne Breiner",
      title: "2022 - Tax Statement",
      tag: "2023",
    },
    {
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
