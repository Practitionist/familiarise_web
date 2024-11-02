import React from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";

interface Approval {
  id: string;
  name: string;
  type: string;
  date: string;
  time: string;
}

interface ApprovalsTableProps {
  approvals: Approval[];
}

export const ApprovalsTable: React.FC<ApprovalsTableProps> = ({
  approvals,
}) => (
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Name</TableHead>
        <TableHead>Type</TableHead>
        <TableHead>Date</TableHead>
        <TableHead>Time</TableHead>
        <TableHead>Actions</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {approvals.map((approval) => (
        <TableRow key={approval.id}>
          <TableCell>{approval.name}</TableCell>
          <TableCell>{approval.type}</TableCell>
          <TableCell>{approval.date}</TableCell>
          <TableCell>{approval.time}</TableCell>
          <TableCell>
            <div className="flex space-x-2">
              <Button className="bg-green-500 text-white">Accept</Button>
              <Button className="bg-red-500 text-white">Reject</Button>
            </div>
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);
