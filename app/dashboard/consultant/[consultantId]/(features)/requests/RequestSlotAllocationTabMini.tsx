import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AppointmentsType, RequestStatus } from "@prisma/client";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface Request {
  id: string;
  type: AppointmentsType;
  title: string;
  requestedBy: {
    user: {
      name: string;
    };
  };
  requestedAt: string;
  status: RequestStatus;
}

export function RequestSlotAllocationTabMini() {
  const router = useRouter();
  const params = useParams();
  const consultantId = params.consultantId as string;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requests, setRequests] = useState<Request[]>([]);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const [consultationsRes, subscriptionsRes] = await Promise.all([
          fetch(
            `/api/events/consultations?consultantProfileId=${consultantId}&status=PENDING`,
          ),
          fetch(
            `/api/events/subscriptions?consultantProfileId=${consultantId}&status=PENDING`,
          ),
        ]);

        const requests = [];
        if (consultationsRes.ok) {
          const data = await consultationsRes.json();
          requests.push(
            ...data.data.map((c: any) => ({
              id: c.id,
              type: AppointmentsType.CONSULTATION,
              title: c.consultationPlan?.title || "Untitled Plan",
              requestedBy: { user: { name: c.requestedBy.user.name } },
              requestedAt: c.requestedAt,
              status: c.requestStatus,
            })),
          );
        }

        if (subscriptionsRes.ok) {
          const data = await subscriptionsRes.json();
          requests.push(
            ...data.data.map((s: any) => ({
              id: s.id,
              type: AppointmentsType.SUBSCRIPTION,
              title: s.subscriptionPlan?.title || "Untitled Plan",
              requestedBy: { user: { name: s.requestedBy.user.name } },
              requestedAt: s.requestedAt,
              status: s.requestStatus,
            })),
          );
        }

        setRequests(requests);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load requests",
        );
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [consultantId]);

  if (loading) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Loading requests...
      </div>
    );
  }

  if (error) {
    return <div className="p-4 text-red-600">{error}</div>;
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[100px]">Type</TableHead>
            <TableHead className="max-w-[200px]">Title</TableHead>
            <TableHead>Requested By</TableHead>
            <TableHead className="w-[140px]">Requested At</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {requests.map((request) => (
            <TableRow key={request.id}>
              <TableCell className="font-medium">{request.type}</TableCell>
              <TableCell className="truncate">{request.title}</TableCell>
              <TableCell>{request.requestedBy.user.name}</TableCell>
              <TableCell>
                {new Date(request.requestedAt).toLocaleDateString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="mt-4 flex justify-end pr-4">
        <Button
          variant="outline"
          onClick={() =>
            router.push(`/dashboard/consultant/${consultantId}/requests`)
          }
        >
          See All Requests →
        </Button>
      </div>
      {requests.length === 0 && (
        <div className="p-4 text-center text-muted-foreground">
          No pending requests
        </div>
      )}
    </div>
  );
}
