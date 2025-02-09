"use client"

import { useParams } from "next/navigation"
import { EventManagementDashboard } from "./components/EventManagementDashboard"

export default function PlannerPage() {
  const params = useParams()
  const consultantId = params.consultantId as string

  return <EventManagementDashboard consultantId={consultantId} />
}
