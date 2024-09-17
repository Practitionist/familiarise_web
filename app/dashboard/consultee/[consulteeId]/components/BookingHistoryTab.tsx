"use client"

import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

export default function BookingHistoryTab() {
  const bookings = [
    { id: 1, date: '2023-06-15', consultant: 'John Doe', service: 'Business Strategy', status: 'Completed' },
    { id: 2, date: '2023-06-22', consultant: 'Jane Smith', service: 'Marketing Consultation', status: 'Upcoming' },
    { id: 3, date: '2023-07-01', consultant: 'Mike Johnson', service: 'Financial Planning', status: 'Cancelled' },
  ];

  return (
    <div className="min-h-[calc(100vh-200px)] space-y-6 overflow-y-auto">
      <h2 className="text-3xl font-bold mb-6">Booking History</h2>
      
      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Your Past and Upcoming Bookings</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Consultant</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bookings.map((booking) => (
                <TableRow key={booking.id} className="bg-white">
                  <TableCell>{booking.date}</TableCell>
                  <TableCell>{booking.consultant}</TableCell>
                  <TableCell>{booking.service}</TableCell>
                  <TableCell>{booking.status}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}