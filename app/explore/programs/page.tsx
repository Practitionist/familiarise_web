"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import Image from "next/image"

interface ConsultantProfile {
  id: string
  description: string
  qualifications: string
  specialization: string
  experience: string
  rating: number
}

interface Program {
  id: string
  title: string
  description: string
  price: number
  type: 'class' | 'webinar'
  language: string
  level: string
  maxParticipants: number
  imageUrl: string
  consultantProfile: ConsultantProfile
  prerequisites: string
  materialProvided: string
  learningOutcomes: string[]
}

export default function Programs() {
  const [programs, setPrograms] = useState<Program[]>([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [searchTerm, setSearchTerm] = useState("")
  const [selectedCategory, setSelectedCategory] = useState("all")
  const [sortBy, setSortBy] = useState("")
  const [viewMode, setViewMode] = useState("grid")
  const observer = useRef<IntersectionObserver>()
  const ITEMS_PER_PAGE = 9

  const lastElementRef = useCallback((node: HTMLDivElement) => {
    if (loading) return
    if (observer.current) observer.current.disconnect()
    observer.current = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore) {
        setPage(prevPage => prevPage + 1)
      }
    })
    if (node) observer.current.observe(node)
  }, [loading, hasMore])

  const fetchPrograms = async (pageNum: number, isNewSearch: boolean = false) => {
    try {
      setLoading(true)
      const [classesRes, webinarsRes] = await Promise.all([
        fetch(`/api/plans/classes?page=${pageNum}&limit=${ITEMS_PER_PAGE}`),
        fetch(`/api/plans/webinars?page=${pageNum}&limit=${ITEMS_PER_PAGE}`)
      ])

      const classesData = await classesRes.json()
      const webinarsData = await webinarsRes.json()

      const formattedClasses = classesData.data.map((item: any) => ({
        ...item,
        type: 'class',
        imageUrl: `https://picsum.photos/seed/${item.id}/600/400`
      }))

      const formattedWebinars = webinarsData.data.map((item: any) => ({
        ...item,
        type: 'webinar',
        imageUrl: `https://picsum.photos/seed/${item.id}/600/400`
      }))

      const newPrograms = [...formattedClasses, ...formattedWebinars]
      
      setPrograms(prev => isNewSearch ? newPrograms : [...prev, ...newPrograms])
      setHasMore(newPrograms.length === ITEMS_PER_PAGE * 2) // Since we're fetching from two endpoints
    } catch (error) {
      console.error('Error fetching programs:', error)
    } finally {
      setLoading(false)
    }
  }

  // Initial load
  useEffect(() => {
    fetchPrograms(1, true)
  }, [])

  // Handle page changes for infinite scroll
  useEffect(() => {
    if (page > 1) {
      fetchPrograms(page, false)
    }
  }, [page])

  // Handle search and filter changes
  useEffect(() => {
    setPrograms([])
    setPage(1)
    setHasMore(true)
    fetchPrograms(1, true)
  }, [searchTerm, selectedCategory])

  const filteredAndSortedPrograms = programs
    .filter((item) => {
      const searchMatch = item.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.description.toLowerCase().includes(searchTerm.toLowerCase())
      const categoryMatch = selectedCategory === "all" ? true : item.level === selectedCategory
      return searchMatch && categoryMatch
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'price-asc':
          return a.price - b.price
        case 'price-desc':
          return b.price - a.price
        case 'title-asc':
          return a.title.localeCompare(b.title)
        case 'title-desc':
          return b.title.localeCompare(a.title)
        default:
          return 0
      }
    })

  const uniqueLevels = Array.from(new Set(programs.map(program => program.level)))

  return (
    <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-40 pb-32">
      <div className="mb-12 text-center">
        <h1 className="text-4xl font-bold mb-3 text-black">
          Search Classes and Webinars
        </h1>
        <p className="text-gray-600 text-lg">
          Find the perfect class or webinar to suit your needs.
        </p>
      </div>

      <div className="bg-white shadow-lg rounded-xl p-6 mb-12">
        <form className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          <div>
            <Label htmlFor="search" className="text-black font-medium">Search</Label>
            <Input
              id="search"
              type="text"
              placeholder="Search classes and webinars"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="category" className="text-black font-medium">Level</Label>
            <Select value={selectedCategory} onValueChange={setSelectedCategory}>
              <SelectTrigger id="category" className="mt-1">
                <SelectValue placeholder="Select a level" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="bg-white">All Levels</SelectItem>
                {uniqueLevels.map((level) => (
                  <SelectItem key={level} value={level} className="bg-white">
                    {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="sort" className="text-black font-medium">Sort By</Label>
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger id="sort" className="mt-1">
                <SelectValue placeholder="Select sorting option" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="price-asc" className="bg-white">Price: Low to High</SelectItem>
                <SelectItem value="price-desc" className="bg-white">Price: High to Low</SelectItem>
                <SelectItem value="title-asc" className="bg-white">Title: A to Z</SelectItem>
                <SelectItem value="title-desc" className="bg-white">Title: Z to A</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </form>
      </div>

      <div className="flex items-center justify-between mb-8">
        <div className="space-x-3">
          <Button
            variant={viewMode === "grid" ? "night" : "default"}
            onClick={() => setViewMode("grid")}
            className="shadow-sm hover:shadow-md transition-shadow"
          >
            Grid View
          </Button>
          <Button 
            variant={viewMode === "list" ? "night" : "default"} 
            onClick={() => setViewMode("list")}
            className="shadow-sm hover:shadow-md transition-shadow"
          >
            List View
          </Button>
        </div>
      </div>

      {viewMode === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredAndSortedPrograms.map((item, index) => (
            <div 
              key={item.id} 
              ref={index === filteredAndSortedPrograms.length - 1 ? lastElementRef : null}
              className="bg-muted rounded-lg overflow-hidden"
            >
              <Image
                src={item.imageUrl}
                alt={item.title}
                width={600}
                height={400}
                className="w-full h-48 object-cover"
                style={{ aspectRatio: "600/400", objectFit: "cover" }}
              />
              <div className="p-4">
                <div className="flex justify-between items-start mb-2">
                  <h3 className="text-lg font-bold">{item.title}</h3>
                  <span className="bg-primary/10 text-primary text-sm px-2 py-1 rounded">
                    {item.type}
                  </span>
                </div>
                <p className="text-muted-foreground mb-4">{item.description}</p>
                <div className="flex items-center justify-between">
                  <div className="text-primary font-medium">${item.price}</div>
                  <Button variant="outline">Learn More</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredAndSortedPrograms.map((item, index) => (
            <div 
              key={item.id}
              ref={index === filteredAndSortedPrograms.length - 1 ? lastElementRef : null}
              className="bg-muted rounded-lg overflow-hidden flex"
            >
              <Image
                src={item.imageUrl}
                alt={item.title}
                width={200}
                height={150}
                className="w-40 h-30 object-cover"
                style={{ aspectRatio: "200/150", objectFit: "cover" }}
              />
              <div className="p-4 flex-1">
                <div className="flex justify-between items-start mb-2">
                  <h3 className="text-lg font-bold">{item.title}</h3>
                  <span className="bg-primary/10 text-primary text-sm px-2 py-1 rounded">
                    {item.type}
                  </span>
                </div>
                <p className="text-muted-foreground mb-4">{item.description}</p>
                <div className="flex items-center justify-between">
                  <div className="text-primary font-medium">${item.price}</div>
                  <Button variant="outline">Learn More</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {loading && (
        <div className="text-center py-4">Loading more...</div>
      )}
    </div>
  )
}
