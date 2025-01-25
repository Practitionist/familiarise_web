import React, { useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Calendar } from './Calendar'

type Request = {
  id: string
  type: 'Consultation' | 'Subscription'
  title: string
  requestedBy: string
  requestedAt: string
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  slots?: string[]
  requiredSlots?: number
}

// Helper function to generate dates for the current month
const generateCurrentMonthDates = (count: number) => {
  const dates = []
  const currentDate = new Date()
  currentDate.setDate(currentDate.getDate() + 1) // Start from tomorrow
  while (dates.length < count) {
    if (currentDate.getDay() !== 0 && currentDate.getDay() !== 6) { // Exclude weekends
      for (let hour = 9; hour <= 17; hour += 2) { // 9 AM to 5 PM, every 2 hours
        dates.push(new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), hour, 0, 0).toISOString())
      }
    }
    currentDate.setDate(currentDate.getDate() + 1)
  }
  return dates
}

// Mock data
const mockRequests: Request[] = [
  { id: '1', type: 'Consultation', title: '1-on-1 Career Advice', requestedBy: 'John Doe', requestedAt: new Date().toISOString().split('T')[0], status: 'PENDING' },
  { id: '2', type: 'Subscription', title: 'Monthly Mentorship', requestedBy: 'Jane Smith', requestedAt: new Date().toISOString().split('T')[0], status: 'PENDING', requiredSlots: 4 },
  { id: '3', type: 'Subscription', title: 'Weekly Check-ins', requestedBy: 'Alice Johnson', requestedAt: new Date().toISOString().split('T')[0], status: 'PENDING', requiredSlots: 8 },
]

const mockAvailableSlots = generateCurrentMonthDates(30)
const mockExistingAppointments = generateCurrentMonthDates(10)

export function RequestsApprovals() {
  const [requests, setRequests] = useState<Request[]>(mockRequests)
  const [selectedRequest, setSelectedRequest] = useState<Request | null>(null)
  const [selectedSlots, setSelectedSlots] = useState<string[]>([])

  const handleApprove = (id: string) => {
    setRequests(requests.map(request => 
      request.id === id ? { ...request, status: 'APPROVED' } : request
    ))
  }

  const handleReject = (id: string) => {
    setRequests(requests.map(request => 
      request.id === id ? { ...request, status: 'REJECTED' } : request
    ))
  }

  const handleAllocateSlots = (id: string) => {
    const request = requests.find(r => r.id === id)
    if (request) {
      setSelectedRequest(request)
      setSelectedSlots([])
    }
  }

  const handleSlotSelect = (slot: string) => {
    setSelectedSlots(prevSlots => {
      if (prevSlots.includes(slot)) {
        return prevSlots.filter(s => s !== slot)
      } else if (selectedRequest && prevSlots.length < selectedRequest.requiredSlots!) {
        return [...prevSlots, slot]
      }
      return prevSlots
    })
  }

  const handleManualSlotAllocation = () => {
    if (selectedRequest) {
      setRequests(requests.map(request => 
        request.id === selectedRequest.id ? { ...request, slots: selectedSlots, status: 'APPROVED' } : request
      ))
      setSelectedRequest(null)
      setSelectedSlots([])
    }
  }

  const handleAutoSlotAllocation = () => {
    if (selectedRequest && selectedRequest.requiredSlots) {
      const availableNonClashingSlots = mockAvailableSlots.filter(slot => !mockExistingAppointments.includes(slot))
      if (availableNonClashingSlots.length >= selectedRequest.requiredSlots) {
        const autoSlots = availableNonClashingSlots.slice(0, selectedRequest.requiredSlots)
        setRequests(requests.map(request => 
          request.id === selectedRequest.id ? { ...request, slots: autoSlots, status: 'APPROVED' } : request
        ))
        setSelectedRequest(null)
        setSelectedSlots([])
      } else {
        alert("Not enough non-clashing slots available for auto-allocation. Please use manual allocation.")
      }
    }
  }

  const isQuotaMet = selectedRequest?.requiredSlots === selectedSlots.length
  const canAutoAllocate = selectedRequest?.requiredSlots && 
    mockAvailableSlots.filter(slot => !mockExistingAppointments.includes(slot)).length >= selectedRequest.requiredSlots

  return (
    <Card>
      <CardHeader>
        <CardTitle>Requests and Approvals</CardTitle>
        <CardDescription>Manage incoming requests for your services</CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="all">
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="consultations">Consultations</TabsTrigger>
            <TabsTrigger value="subscriptions">Subscriptions</TabsTrigger>
          </TabsList>
          {['all', 'consultations', 'subscriptions'].map((tab) => (
            <TabsContent key={tab} value={tab}>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Requested By</TableHead>
                    <TableHead>Requested At</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requests
                    .filter(request => tab === 'all' || request.type.toLowerCase() === tab.slice(0, -1))
                    .map((request) => (
                      <TableRow key={request.id}>
                        <TableCell>{request.type}</TableCell>
                        <TableCell>{request.title}</TableCell>
                        <TableCell>{request.requestedBy}</TableCell>
                        <TableCell>{request.requestedAt}</TableCell>
                        <TableCell>
                          <Badge 
                            variant={request.status === 'PENDING' ? 'outline' : 
                                     request.status === 'APPROVED' ? 'default' : 'destructive'}
                          >
                            {request.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {request.status === 'PENDING' && (
                            <>
                              {request.type === 'Consultation' ? (
                                <Button variant="outline" size="sm" onClick={() => handleApprove(request.id)}>
                                  Approve
                                </Button>
                              ) : (
                                <Dialog>
                                  <DialogTrigger asChild>
                                    <Button variant="outline" size="sm" onClick={() => handleAllocateSlots(request.id)}>
                                      Allocate Slots
                                    </Button>
                                  </DialogTrigger>
                                  <DialogContent className="max-w-3xl">
                                    <DialogHeader>
                                      <DialogTitle>Allocate Slots for Subscription</DialogTitle>
                                      <DialogDescription>
                                        Choose slots for the subscription. Required slots: {request.requiredSlots}
                                      </DialogDescription>
                                    </DialogHeader>
                                    <Calendar
                                      availableSlots={mockAvailableSlots}
                                      existingAppointments={mockExistingAppointments}
                                      onSlotSelect={handleSlotSelect}
                                      selectedSlots={selectedSlots}
                                      requiredSlots={selectedRequest?.requiredSlots || 0}
                                    />
                                    <DialogFooter>
                                      <Button variant="outline" onClick={handleAutoSlotAllocation} disabled={!canAutoAllocate}>
                                        Auto Allocate
                                      </Button>
                                      <Button onClick={handleManualSlotAllocation} disabled={!isQuotaMet}>
                                        Allocate Manual Slots
                                      </Button>
                                    </DialogFooter>
                                  </DialogContent>
                                </Dialog>
                              )}
                              <Button variant="outline" size="sm" className="ml-2" onClick={() => handleReject(request.id)}>
                                Reject
                              </Button>
                            </>
                          )}
                          {request.status === 'APPROVED' && request.slots && (
                            <div>
                              Allocated Slots: {request.slots.join(', ')}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  )
}

