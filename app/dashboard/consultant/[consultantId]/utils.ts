export interface Consultant {
  name: string;
  role: string;
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
  // Implement API call to fetch consultant data
  // Return mock data for now
  return { name: 'Mike Steele', role: 'Manager' };
}

export async function fetchAppointments(id: string): Promise<Appointment[]> {
  // Implement API call to fetch appointments
  // Return mock data for now
  return [
    { id: '1', name: 'Olga Nunez', description: 'Invoice Negotiation', time: '3:00 PM - 3:30 PM', badge: 'Meeting in 5 min' },
    { id: '2', name: 'John Doe', description: 'Project Review', time: '4:00 PM - 4:30 PM', badge: 'Meeting in 2 hours' },
    { id: '3', name: 'Jane Smith', description: 'Consultation', time: '10:00 AM - 11:00 AM', badge: 'Tomorrow' },
    { id: '4', name: 'Bob Johnson', description: 'Follow-up', time: '2:00 PM - 2:30 PM', badge: 'Next Week' },
  ];
}

export async function fetchDocuments(id: string): Promise<Document[]> {
  // Implement API call to fetch documents
  // Return mock data for now
  return [
    { invoiceNo: '2150', clientName: 'Andrea Jennings', title: '2020 - Tax Statement', tag: '2023' },
    { invoiceNo: '2151', clientName: 'Stacey Larson', title: '2021 - Tax Statement', tag: '2023' },
    { invoiceNo: '2152', clientName: 'Yvonne Breiner', title: '2022 - Tax Statement', tag: '2023' },
    { invoiceNo: '2153', clientName: 'Steven Glover', title: '2023 - Tax Statement', tag: '2023' },
  ];
}

export async function fetchActivities(id: string): Promise<Activity[]> {
  // Implement API call to fetch activities
  // Return mock data for now
  return [
    { id: '1', name: 'Stephen', action: 'Stephen joined to 🎨 channel.', time: '20m ago' },
    { id: '2', name: 'Alice', action: 'Alice uploaded a new document.', time: '1h ago' },
    { id: '3', name: 'Bob', action: 'Bob scheduled a meeting.', time: '2h ago' },
  ];
}

export async function fetchApprovals(id: string): Promise<Approval[]> {
  // Implement API call to fetch approvals
  // Return mock data for now
  return [
    { id: '1', name: 'John Smith', type: 'Consultation', date: '2023-07-01', time: '10:00 AM' },
    { id: '2', name: 'Jane Doe', type: 'Subscription', date: '2023-07-02', time: '2:00 PM' },
    { id: '3', name: 'Bob Johnson', type: 'Consultation', date: '2023-07-03', time: '11:30 AM' },
    { id: '4', name: 'Alice Brown', type: 'Subscription', date: '2023-07-04', time: '3:30 PM' },
  ];
}