import React, { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import { updateApprovalStatus } from "../utils";
import { useParams } from "next/navigation";

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
}) => {
  const params = useParams();
  const consultantId = params.consultantId as string;
  const [loading, setLoading] = useState<{ [key: string]: boolean }>({});

  const handleApproval = async (id: string, status: 'APPROVED' | 'REJECTED', type: string) => {
    try {
      setLoading(prev => ({ ...prev, [id]: true }));

      await updateApprovalStatus(
        consultantId, 
        id, 
        status, 
        type.toLowerCase() as 'consultation' | 'subscription'
      );

      toast({
        title: "Success",
        description: `Request ${status.toLowerCase()} successfully`,
      });

      // Refresh the page to update the data
      window.location.reload();
    } catch (error) {
      console.error('Error updating approval status:', error);
      toast({
        title: "Error",
        description: "Failed to update request status",
        variant: "destructive",
      });
    } finally {
      setLoading(prev => ({ ...prev, [id]: false }));
    }
  };

  // Log props for debugging
  console.log('ApprovalsTable props:', {
    approvals: approvals.map(a => ({
      id: a.id,
      name: a.name,
      type: a.type,
      date: a.date,
      time: a.time
    }))
  });

  if (approvals.length === 0) {
    return (
      <div className="text-center py-4 text-gray-500">
        No pending approvals
      </div>
    );
  }

  return (
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
                <Button 
                  className="bg-green-500 text-white hover:bg-green-600"
                  onClick={() => handleApproval(approval.id, 'APPROVED', approval.type)}
                  disabled={loading[approval.id]}
                >
                  {loading[approval.id] ? 'Processing...' : 'Accept'}
                </Button>
                <Button 
                  className="bg-red-500 text-white hover:bg-red-600"
                  onClick={() => handleApproval(approval.id, 'REJECTED', approval.type)}
                  disabled={loading[approval.id]}
                >
                  {loading[approval.id] ? 'Processing...' : 'Reject'}
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};
