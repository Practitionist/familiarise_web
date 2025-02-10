"use client"

import React, { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ClassEvent } from "../../../types/event"
import { useParams } from "next/navigation"

export default function ClassParticipantsPage() {
  const params = useParams()
  const [classEvent, setClassEvent] = useState<ClassEvent | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await fetch(`/api/participants/class/${params.classId}`)
        if (!response.ok) {
          throw new Error('Failed to fetch class data')
        }
        const data = await response.json()
        setClassEvent(data.classEvent)
        setLoading(false)
      } catch (error) {
        console.error('Error fetching class data:', error)
        setLoading(false)
      }
    }

    fetchData()
  }, [params.classId])

  const handleRemoveParticipant = async (userId: string) => {
    try {
      const response = await fetch(`/api/participants/class/${params.classId}?userId=${userId}`, {
        method: 'DELETE',
      })
      
      if (!response.ok) {
        throw new Error('Failed to remove participant')
      }

      // Refresh the data
      const updatedResponse = await fetch(`/api/participants/class/${params.classId}`)
      if (!updatedResponse.ok) {
        throw new Error('Failed to fetch updated class data')
      }
      const updatedData = await updatedResponse.json()
      setClassEvent(updatedData.classEvent)
    } catch (error) {
      console.error('Error removing participant:', error)
    }
  }

  if (loading) {
    return <div>Loading...</div>
  }

  if (!classEvent) {
    return <div>Class not found</div>
  }

  // Get unique participants by user ID
  const participants = Array.from(new Map(
    (classEvent.appointments || []).flatMap(
      appointment => 
        (appointment.slotsOfAppointment || []).flatMap(slot => slot.user || []) || []
    ).map(user => [user.id, user]) || []
  ).values())

  return (
    <div className="container mx-auto py-8">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl font-bold">
            {classEvent.classPlan.title} - Participants
          </CardTitle>
          <p className="text-sm text-gray-500">
            {participants.length}/{classEvent.classPlan.maxParticipants} participants
          </p>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {participants.map((participant) => (
                <TableRow key={participant.id}>
                  <TableCell>{participant.name}</TableCell>
                  <TableCell>{participant.email}</TableCell>
                  <TableCell>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                      Registered
                    </span>
                  </TableCell>
                  <TableCell>
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => handleRemoveParticipant(participant.id)}
                    >
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
