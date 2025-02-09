"use client"

import React from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Users, Edit } from "lucide-react"
import Link from "next/link"
import { ChevronLeftIcon, ChevronRightIcon } from "@radix-ui/react-icons"
import { WebinarEvent, ClassEvent, Event } from "../types"

interface WebinarCarouselProps {
  events: WebinarEvent[];
  onEdit: (event: WebinarEvent) => void;
  eventType: "webinar";
}

interface ClassCarouselProps {
  events: ClassEvent[];
  onEdit: (event: ClassEvent) => void;
  eventType: "class";
}

type EventCarouselProps = WebinarCarouselProps | ClassCarouselProps;

function isWebinarEvent(event: Event): event is WebinarEvent {
  return event.type === "webinar";
}

function isClassEvent(event: Event): event is ClassEvent {
  return event.type === "class";
}

export function EventCarousel({ events, onEdit, eventType }: EventCarouselProps) {
  const [startIndex, setStartIndex] = React.useState(0)

  const nextSlide = () => {
    setStartIndex((prevIndex) => (prevIndex + 3) % events.length)
  }

  const prevSlide = () => {
    setStartIndex((prevIndex) => (prevIndex - 3 + events.length) % events.length)
  }

  const getEventTitle = (event: Event) => {
    return isWebinarEvent(event)
      ? event.webinarPlan.title 
      : event.classPlan.title
  }

  const getEventDescription = (event: Event) => {
    return isWebinarEvent(event)
      ? event.webinarPlan.description || ''
      : event.classPlan.description || ''
  }

  const getEventPrice = (event: Event) => {
    return isWebinarEvent(event)
      ? event.webinarPlan.price
      : event.classPlan.price
  }

  const getEventDuration = (event: Event) => {
    return isWebinarEvent(event)
      ? `${event.webinarPlan.durationInHours} hours`
      : `${event.classPlan.durationInMonths} months`
  }

  const getParticipantsCount = (event: Event) => {
    if (isWebinarEvent(event)) {
      const currentParticipants = event.appointment?.slotsOfAppointment?.reduce(
        (count: number, slot: { user: any[] }) => count + (slot.user?.length || 0),
        0
      ) || 0
      return {
        currentParticipants,
        maxParticipants: event.webinarPlan.maxParticipants
      }
    } else {
      const currentParticipants = event.appointments?.reduce(
        (count: number, appointment: { slotsOfAppointment?: { user: any[] }[] }) => 
          count + (appointment.slotsOfAppointment?.reduce(
            (slotCount: number, slot: { user: any[] }) => slotCount + (slot.user?.length || 0),
            0
          ) || 0),
        0
      ) || 0
      return {
        currentParticipants,
        maxParticipants: event.classPlan.maxParticipants
      }
    }
  }

  const handleEdit = (event: Event) => {
    if (eventType === "webinar" && isWebinarEvent(event)) {
      onEdit(event)
    } else if (eventType === "class" && isClassEvent(event)) {
      onEdit(event)
    }
  }

  return (
    <div className="relative">
      <div className="flex overflow-hidden">
        {events.slice(startIndex, startIndex + 3).map((event) => {
          const { currentParticipants, maxParticipants } = getParticipantsCount(event)
          
          return (
            <Card key={event.id} className="w-1/3 flex-shrink-0 m-2 bg-white shadow-lg rounded-lg overflow-hidden">
              <CardHeader className="bg-gray-50 border-b">
                <CardTitle className="text-lg font-semibold text-gray-800">
                  {getEventTitle(event)}
                </CardTitle>
                <CardDescription className="text-sm text-gray-600">
                  {currentParticipants}/{maxParticipants} participants
                </CardDescription>
              </CardHeader>
              <CardContent className="p-4">
                <p className="text-sm text-gray-700 mb-2">{getEventDescription(event)}</p>
                <p className="text-sm font-medium text-gray-900">Price: ${getEventPrice(event)}</p>
                <p className="text-sm text-gray-600">Duration: {getEventDuration(event)}</p>
              </CardContent>
              <CardFooter className="bg-gray-50 border-t p-4 flex justify-between">
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/dashboard/consultant/${event.id}/participants`}>
                    <Users className="w-4 h-4 mr-2" />
                    Manage Participants
                  </Link>
                </Button>
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={() => handleEdit(event)}
                >
                  <Edit className="w-4 h-4 mr-2" />
                  Edit Event
                </Button>
              </CardFooter>
            </Card>
          )
        })}
      </div>
      {events.length > 3 && (
        <>
          <Button
            variant="outline"
            size="icon"
            className="absolute top-1/2 left-0 transform -translate-y-1/2 bg-white shadow-md"
            onClick={prevSlide}
          >
            <ChevronLeftIcon className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="absolute top-1/2 right-0 transform -translate-y-1/2 bg-white shadow-md"
            onClick={nextSlide}
          >
            <ChevronRightIcon className="h-4 w-4" />
          </Button>
        </>
      )}
    </div>
  )
}
