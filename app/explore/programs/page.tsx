"use client"

import { useState, useEffect } from "react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import Image from "next/image"

interface Program {
  id: string
  title: string
  description: string
  price: number
  type: 'class' | 'webinar'
  language?: string
  level?: string
  maxParticipants: number
  imageUrl: string
}

interface PaginationMeta {
  total: number
  page: number
  limit: number
  totalPages: number
}

export default function Programs() {
  const [programs, setPrograms] = useState<Program[]>([])
  const [meta, setMeta] = useState<PaginationMeta>({ total: 0, page: 1, limit: 9, totalPages: 0 })
  const [searchTerm, setSearchTerm] = useState("")
  const [selectedCategory, setSelectedCategory] = useState("all")
  const [sortBy, setSortBy] = useState("")
  const [viewMode, setViewMode] = useState("grid")
  const [loading, setLoading] = useState(true)

  const fetchPrograms = async (page: number) => {
    try {
      setLoading(true)
      const [classesRes, webinarsRes] = await Promise.all([
        fetch(`/api/plans/classes?page=${page}&limit=${meta.limit}`),
        fetch(`/api/plans/webinars?page=${page}&limit=${meta.limit}`)
      ])

      const classesData = await classesRes.json()
      const webinarsData = await webinarsRes.json()

      const formattedClasses = classesData.data.map((item: any) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        price: item.price,
        type: 'class',
        language: item.language,
        type: 'class',
        imageUrl: `https://picsum.photos/seed/${item.id}/600/400`
      }))

      const formattedWebinars = webinarsData.data.map((item: any) => ({
        ...item,
        type: 'webinar',
        imageUrl: `https://picsum.photos/seed/${item.id}/600/400`
      }))

      setPrograms([...formattedClasses, ...formattedWebinars])
      
      // Combine meta data from both endpoints
      const totalItems = classesData.meta.total + webinarsData.meta.total
      setMeta({
        total: totalItems,
        page: page,
        limit: meta.limit,
        totalPages: Math.ceil(totalItems / meta.limit)
      })
    } catch (error) {
      console.error('Error fetching programs:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPrograms(1)
  }, [])

  const filteredAndSortedPrograms = programs
    .filter((item) => {
      const searchMatch = item.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.description.toLowerCase().includes(searchTerm.toLowerCase())
      const categoryMatch = selectedCategory === "all" ? true : 
        (item.topics?.some(topic => topic.name === selectedCategory))
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

  const uniqueCategories = Array.from(new Set(
    programs.flatMap(program => program.topics?.map(topic => topic.name) || [])
  ))

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= meta.totalPages) {
      fetchPrograms(newPage)
    }
  }

  return (
    <div className="w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-32">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold mb-2 bg-gradient-to-r from-black via-gray-700 to-gray-400 text-transparent bg-clip-text">
          Search Classes and Webinars
        </h1>
        <p className="text-muted-foreground bg-gradient-to-r from-gray-800 via-gray-600 to-gray-400 text-transparent bg-clip-text">
          Find the perfect class or webinar to suit your needs.
        </p>
      </div>

      <div className="bg-muted rounded-lg p-4 sm:p-6 mb-8">
        <form className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <Label htmlFor="search">Search</Label>
            <Input
              id="search"
              type="text"
              placeholder="Search classes and webinars"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="category">Category</Label>
            <Select value={selectedCategory} onValueChange={setSelectedCategory}>
              <SelectTrigger id="category">
                <SelectValue placeholder="Select a category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="bg-white">All Categories</SelectItem>
                {uniqueCategories.map((category) => (
                  <SelectItem key={category} value={category} className="bg-white">
                    {category}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="sort">Sort By</Label>
            <Select value={sortBy} onValueChange={setSortBy}>
              <SelectTrigger id="sort">
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

      <div className="flex items-center justify-between mb-4">
        <div>
          <Button
            variant={viewMode === "grid" ? "night" : "default"}
            onClick={() => setViewMode("grid")}
            className="mr-2"
          >
            Grid View
          </Button>
          <Button 
            variant={viewMode === "list" ? "night" : "default"} 
            onClick={() => setViewMode("list")}
          >
            List View
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-10">Loading...</div>
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredAndSortedPrograms.map((item) => (
            <div key={item.id} className="bg-muted rounded-lg overflow-hidden">
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
          {filteredAndSortedPrograms.map((item) => (
            <div key={item.id} className="bg-muted rounded-lg overflow-hidden flex">
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

      {/* Pagination Controls */}
      <div className="mt-8 flex justify-center gap-2">
        <Button
          variant="outline"
          onClick={() => handlePageChange(meta.page - 1)}
          disabled={meta.page === 1}
        >
          Previous
        </Button>
        <div className="flex items-center gap-2">
          {Array.from({ length: meta.totalPages }, (_, i) => i + 1).map((pageNum) => (
            <Button
              key={pageNum}
              variant={pageNum === meta.page ? "night" : "outline"}
              onClick={() => handlePageChange(pageNum)}
            >
              {pageNum}
            </Button>
          ))}
        </div>
        <Button
          variant="outline"
          onClick={() => handlePageChange(meta.page + 1)}
          disabled={meta.page === meta.totalPages}
        >
          Next
        </Button>
      </div>
    </div>
  )
}
