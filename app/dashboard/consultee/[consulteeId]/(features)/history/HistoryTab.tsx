"use client";

import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "components/ui/card";
import { Badge } from "components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "components/ui/avatar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "components/ui/table";

export default function HistoryTab() {
  return (
    <div className="min-h-[calc(100vh-200px)] p-6 bg-gray-50">
      <div className="bg-white rounded-xl p-8 shadow-sm border border-gray-100 mb-6">
        <h2 className="text-3xl font-bold text-gray-900">Booking History</h2>
        <p className="mt-2 text-gray-600">
          View all your past and upcoming sessions
        </p>
      </div>

      <Card className="bg-white shadow-sm border border-gray-100">
        <CardHeader className="p-6">
          <CardTitle className="text-xl font-semibold">
            Your Learning Journey
          </CardTitle>
        </CardHeader>
        <CardContent className="p-6 pt-0">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-gray-50">
                  <TableHead className="font-semibold">Booking Date</TableHead>
                  <TableHead className="font-semibold">Payment Date</TableHead>
                  <TableHead className="font-semibold">Session</TableHead>
                  <TableHead className="font-semibold">Expert</TableHead>
                  <TableHead className="font-semibold">Status</TableHead>
                  <TableHead className="font-semibold">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-gray-500">
                    No bookings found
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
