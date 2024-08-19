"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import Link from "next/link";
import { Suspense, useEffect, useState } from 'react';

// Fetch functions (to be implemented)
async function fetchConsultantData(id: string) {
  // Implement API call to fetch consultant data
  // Return mock data for now
  return { name: 'Mike Steele', role: 'Manager' };
}

async function fetchAppointments(id: string) {
  // Implement API call to fetch appointments
  // Return mock data for now
  return [
    { id: '1', name: 'Olga Nunez', description: 'Invoice Negotiation', time: '3:00 PM - 3:30 PM', badge: 'Meeting in 5 min' },
    { id: '2', name: 'John Doe', description: 'Project Review', time: '4:00 PM - 4:30 PM', badge: 'Meeting in 2 hours' },
  ];
}

async function fetchDocuments(id: string) {
  // Implement API call to fetch documents
  // Return mock data for now
  return [
    { invoiceNo: '2150', clientName: 'Andrea Jennings', title: '2020 - Tax Statement', tag: '2023' },
    { invoiceNo: '2151', clientName: 'Stacey Larson', title: '2021 - Tax Statement', tag: '2023' },
    { invoiceNo: '2152', clientName: 'Yvonne Breiner', title: '2022 - Tax Statement', tag: '2023' },
    { invoiceNo: '2153', clientName: 'Steven Glover', title: '2023 - Tax Statement', tag: '2023' },
  ];
}

async function fetchActivities(id: string) {
  // Implement API call to fetch activities
  // Return mock data for now
  return [
    { id: '1', name: 'Stephen', action: 'Stephen joined to 🎨 channel.', time: '20m ago' },
    { id: '2', name: 'Alice', action: 'Alice uploaded a new document.', time: '1h ago' },
    { id: '3', name: 'Bob', action: 'Bob scheduled a meeting.', time: '2h ago' },
  ];
}

async function fetchBirthdays(id: string) {
  // Implement API call to fetch birthdays
  // Return mock data for now
  return [
    { id: '1', name: 'Jesus Cardoza', date: '24 March' },
    { id: '2', name: 'Andrea Jennings', date: '25 March' },
    { id: '3', name: 'Yvonne Breiner', date: '26 March' },
    { id: '4', name: 'Gabriel Dennis', date: '27 March' },
  ];
}

// Separate components (keep as they are)
const Header = ({ name, role }: { name: string; role: string }) => (
  <header className="flex items-center justify-between pb-6">
    <div className="flex items-center">
      <div className="mr-6">
        <Avatar>
          <AvatarImage alt={name} src="/placeholder.svg" />
          <AvatarFallback>{name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
        </Avatar>
      </div>
      <div>
        <h1 className="text-2xl font-semibold">{name}</h1>
        <p className="text-sm text-gray-500">{role}</p>
      </div>
    </div>
    <div className="flex space-x-4">
      <SettingsIcon className="text-gray-500" />
      <SignalIcon className="text-gray-500" />
      <SearchIcon className="text-gray-500" />
    </div>
  </header>
);

const Sidebar = () => (
  <aside className="col-span-2">
    <nav className="space-y-1">
      {['Home', 'Calendar', 'CRM', 'Documents', 'Reports', 'Help', 'Logout'].map((item, index) => (
        <Link
          key={item}
          className={`block p-3 rounded-lg ${index === 0 ? 'bg-blue-500 text-white' : 'text-gray-600 hover:bg-gray-200'}`}
          href="#"
        >
          {item}
        </Link>
      ))}
    </nav>
    <div className="mt-6 p-4 bg-white rounded-lg shadow">
      <h2 className="text-lg font-semibold mb-2">Upgrade Now</h2>
      <p className="text-sm text-gray-600 mb-4">Find out what an improved account offers</p>
      <Button className="bg-blue-500 text-white">Explore Plans</Button>
    </div>
  </aside>
);

const AppointmentCard = ({ name, description, time, badge }: { name: string; description: string; time: string; badge: string }) => (
  <Card className="bg-purple-100">
    <CardHeader>
      <Avatar>
        <AvatarImage alt={name} src="/placeholder.svg" />
        <AvatarFallback>{name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
      </Avatar>
      <div>
        <CardTitle>{name}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </div>
    </CardHeader>
    <CardContent>
      <p className="text-sm">{time}</p>
    </CardContent>
    <CardFooter className="flex justify-between">
      <Badge variant="secondary" className="bg-blue-500 text-white">{badge}</Badge>
      <Button variant="default" className="bg-black text-white">Join meet</Button>
    </CardFooter>
  </Card>
);

interface Document {
  invoiceNo: string;
  clientName: string;
  title: string;
  tag: string;
}

const DocumentReviewTable = ({ documents }: { documents: Document[] }) => (
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead className="w-[100px]">Invoice No.</TableHead>
        <TableHead>Client Name</TableHead>
        <TableHead>Document Title</TableHead>
        <TableHead>Tags</TableHead>
        <TableHead>Actions</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {documents.map((doc) => (
        <TableRow key={doc.invoiceNo}>
          <TableCell className="font-medium">{doc.invoiceNo}</TableCell>
          <TableCell>{doc.clientName}</TableCell>
          <TableCell>{doc.title}</TableCell>
          <TableCell>
            <Badge variant="secondary">{doc.tag}</Badge>
          </TableCell>
          <TableCell className="flex space-x-2">
            <FileEditIcon className="text-gray-500" />
            <DeleteIcon className="text-gray-500" />
            <DownloadIcon className="text-gray-500" />
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

interface Activity {
  id: string;
  name: string;
  action: string;
  time: string;
}

const ClientActivity = ({ activities }: { activities: Activity[] }) => (
  <div className="space-y-4">
    {activities.map((activity) => (
      <div key={activity.id} className="flex items-center justify-between">
        <div className="flex items-center">
          <Avatar>
            <AvatarImage alt={activity.name} src="/placeholder.svg" />
            <AvatarFallback>{activity.name[0]}</AvatarFallback>
          </Avatar>
          <p className="ml-2">{activity.action}</p>
        </div>
        <p className="text-sm text-gray-500">{activity.time}</p>
      </div>
    ))}
  </div>
);

interface Birthday {
  id: string;
  name: string;
  date: string;
}

const UpcomingBirthdays = ({ birthdays }: { birthdays: Birthday[] }) => (
  <div className="space-y-4">
    {birthdays.map((birthday) => (
      <div key={birthday.id} className="flex items-center justify-between">
        <div className="flex items-center">
          <Avatar>
            <AvatarImage alt={birthday.name} src="/placeholder.svg" />
            <AvatarFallback>{birthday.name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
          </Avatar>
          <p className="ml-2">{birthday.name}</p>
        </div>
        <p className="text-sm text-gray-500">{birthday.date}</p>
      </div>
    ))}
  </div>
);
// Main component
export default function ConsultantDashboard({ params }: { readonly params: { consultantId: string } }) {

  const consultantId = params.consultantId;

  const [consultant, setConsultant] = useState<{ name: string; role: string } | null>(null);
  const [appointments, setAppointments] = useState<{ id: string; name: string; description: string; time: string; badge: string; }[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [activities, setActivities] = useState<{ id: string; name: string; action: string; time: string; }[]>([]);
  const [birthdays, setBirthdays] = useState<{ id: string; name: string; date: string; }[]>([]);

  useEffect(() => {
    if (consultantId) {
      fetchConsultantData(consultantId).then(setConsultant);
      fetchAppointments(consultantId).then(setAppointments);
      fetchDocuments(consultantId).then(setDocuments);
      fetchActivities(consultantId).then(setActivities);
      fetchBirthdays(consultantId).then(setBirthdays);
    }
  }, [consultantId]);

  if (!consultant) {
    return <div>Loading...</div>;
  }

  return (
    <div className="bg-gray-100 p-40">
      <Header name={consultant.name} role={consultant.role} />
      <main className="grid grid-cols-12 gap-6">
        <Sidebar />
        <section className="col-span-10">
          <div className="grid grid-cols-3 gap-6">
            <div className="col-span-2">
              <Suspense fallback={<div>Loading appointments...</div>}>
                <div className="bg-white p-6 rounded-lg shadow">
                  <h2 className="text-xl font-semibold mb-4">Today's Appointments</h2>
                  <div className="grid grid-cols-2 gap-4">
                    {appointments.map((appointment) => (
                      <AppointmentCard key={appointment.id} {...appointment} />
                    ))}
                  </div>
                </div>
              </Suspense>
              <Suspense fallback={<div>Loading documents...</div>}>
                <div className="bg-white p-6 rounded-lg shadow mt-6">
                  <h2 className="text-xl font-semibold mb-4">Document For Review</h2>
                  <DocumentReviewTable documents={documents} />
                </div>
              </Suspense>
            </div>
            <div>
              <Suspense fallback={<div>Loading client activity...</div>}>
                <div className="bg-white p-6 rounded-lg shadow">
                  <h2 className="text-xl font-semibold mb-4">Clients Activity</h2>
                  <ClientActivity activities={activities} />
                  <Button className="mt-4 w-full bg-blue-500 text-white">Login Report</Button>
                </div>
              </Suspense>
              <Suspense fallback={<div>Loading birthdays...</div>}>
                <div className="bg-white p-6 rounded-lg shadow mt-6">
                  <h2 className="text-xl font-semibold mb-4">Upcoming Birthdays</h2>
                  <UpcomingBirthdays birthdays={birthdays} />
                </div>
              </Suspense>
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}

function SettingsIcon(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function SignalIcon(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 20h.01" />
      <path d="M7 20v-4" />
      <path d="M12 20v-8" />
      <path d="M17 20V8" />
      <path d="M22 4v16" />
    </svg>
  )
}

function SearchIcon(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

function FileEditIcon(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 13.5V4a2 2 0 0 1 2-2h8.5L20 7.5V20a2 2 0 0 1-2 2h-5.5" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M10.42 12.61a2.1 2.1 0 1 1 2.97 2.97L7.95 21 4 22l.99-3.95 5.43-5.44Z" />
    </svg>
  )
}

function DeleteIcon(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 5H9l-7 7 7 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Z" />
      <line x1="18" x2="12" y1="9" y2="15" />
      <line x1="12" x2="18" y1="9" y2="15" />
    </svg>
  )
}

function DownloadIcon(props: any) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </svg>
  )
}
