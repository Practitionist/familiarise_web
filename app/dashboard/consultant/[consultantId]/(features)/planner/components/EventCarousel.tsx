"use client"

import React from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Users, Edit, Clock } from "lucide-react"
import { TimingsCalendar } from "./TimingsCalendar"
import Link from "next/link"
import { ChevronLeftIcon, ChevronRightIcon } from "@radix-ui/react-icons"
import { WebinarEvent, ClassEvent, Event } from "../types/event"

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
  const [selectedEventId, setSelectedEventId] = React.useState<string | null>(null)
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

  const [participantCounts, setParticipantCounts] = React.useState<Record<string, number>>({})
  const [isLoadingCounts, setIsLoadingCounts] = React.useState(true)

  React.useEffect(() => {
    const fetchParticipantCounts = async () => {
      setIsLoadingCounts(true)
      try {
        for (const event of events) {
        try {
          const response = await fetch(
            isWebinarEvent(event) 
              ? `/api/participants/webinar/${event.id}`
              : `/api/participants/class/${event.id}`
          )
          if (response.ok) {
            const data = await response.json()
            setParticipantCounts(prev => ({
              ...prev,
              [event.id]: data.participants.length
            }))
          }
        } catch (error) {
          console.error('Error fetching participant count:', error)
        }
        }
      } finally {
        setIsLoadingCounts(false)
      }
    }

    if (events.length > 0) {
      fetchParticipantCounts()
    }
  }, [events])

  const getParticipantsCount = (event: Event) => {
    return {
      currentParticipants: participantCounts[event.id] || 0,
      maxParticipants: isWebinarEvent(event) 
        ? event.webinarPlan.maxParticipants 
        : event.classPlan.maxParticipants
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
    <div className="flex items-center gap-4">
      {events.length > 3 && (
        <Button
          variant="outline"
          size="icon"
          className="hidden md:flex bg-white shadow-md"
          onClick={prevSlide}
        >
          <ChevronLeftIcon className="h-4 w-4" />
        </Button>
      )}
      <div className="flex flex-col md:flex-row gap-4 overflow-x-auto md:overflow-hidden">
        {events.slice(startIndex, startIndex + 3).map((event) => {
          const { currentParticipants, maxParticipants } = getParticipantsCount(event)
          
          return (
            <Card key={event.id} className="w-full md:w-1/3 flex-shrink-0 bg-white shadow-lg rounded-lg overflow-hidden flex flex-col">
              <CardHeader className="bg-gray-50 border-b relative flex-shrink-0">
                <Button 
                  variant="ghost" 
                  size="icon"
                  className="absolute right-4 top-4"
                  onClick={() => handleEdit(event)}
                >
                  <Edit className="h-4 w-4" />
                </Button>
                <CardTitle className="text-lg font-semibold text-gray-800 pr-8">
                  {getEventTitle(event)}
                </CardTitle>
                <CardDescription className="text-sm text-gray-600">
                  {isLoadingCounts ? (
                    "Loading participants..."
                  ) : (
                    `${currentParticipants}/${maxParticipants} participants`
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-4 flex-grow">
                <p className="text-sm text-gray-700 mb-2">{getEventDescription(event)}</p>
                <p className="text-sm font-medium text-gray-900">Price: ${getEventPrice(event)}</p>
                <p className="text-sm text-gray-600">Duration: {getEventDuration(event)}</p>
              </CardContent>
              <CardFooter className="bg-gray-50 border-t p-4 flex justify-between flex-shrink-0">
                <Button 
                  variant="outline" 
                  size="sm" 
                  asChild
                >
                  <Link 
                    href={
                      eventType === "webinar" && isWebinarEvent(event)
                        ? `/dashboard/consultant/${event.webinarPlan.consultantProfileId}/planner/webinars/${event.id}/participants`
                        : isClassEvent(event)
                          ? `/dashboard/consultant/${event.classPlan.consultantProfileId}/planner/classes/${event.id}/participants`
                          : "#"
                    }
                  >
                    <Users className="w-4 h-4 mr-2" />
                    Manage Participants
                  </Link>
                </Button>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => setSelectedEventId(event.id)}
                >
                  <Clock className="w-4 h-4 mr-2" />
                  Manage Timings
                </Button>
              </CardFooter>
            </Card>
          )
        })}
      </div>
    <TimingsCalendar 
      isOpen={!!selectedEventId}
      onClose={() => setSelectedEventId(null)}
      eventType={eventType}
      eventId={selectedEventId || ""}
    />
      {events.length > 3 && (
        <Button
          variant="outline"
          size="icon"
          className="hidden md:flex bg-white shadow-md"
          onClick={nextSlide}
        >
          <ChevronRightIcon className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}
