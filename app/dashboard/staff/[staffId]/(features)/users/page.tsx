"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Search,
  Users,
  UserCheck,
  UserX,
  Shield,
  Mail,
  Phone,
  Calendar,
  MapPin,
  MoreHorizontal,
  Eye,
  Flag,
  Ban,
  CheckCircle,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";

// Types
interface User {
  id: string;
  name: string | null;
  email: string | null;
  role: string;
  onboardingCompleted: boolean | null;
  createdAt: string;
  image?: string | null;
  phone?: string | null;
  city?: string | null;
  country?: string | null;
}

interface UserListResponse {
  users: User[];
  total: number;
  page: number;
  totalPages: number;
}

const getRoleColor = (role: string) => {
  switch (role) {
    case "CONSULTANT":
      return "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300";
    case "CONSULTEE":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300";
    case "ADMIN":
      return "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300";
    case "STAFF":
      return "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
};

const getStatusColor = (onboardingCompleted: boolean | null) => {
  if (onboardingCompleted === true) {
    return "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300";
  } else if (onboardingCompleted === false) {
    return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300";
  }
  return "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
};

const getStatusText = (onboardingCompleted: boolean | null) => {
  if (onboardingCompleted === true) return "active";
  if (onboardingCompleted === false) return "pending";
  return "unknown";
};

const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

export default function UserManagementPage() {
  const { toast } = useToast();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);

  // Debounced search
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("page", page.toString());
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (roleFilter !== "all") params.set("role", roleFilter);

      const response = await fetch(`/api/admin/users?${params}`);
      if (!response.ok) throw new Error("Failed to fetch users");

      const data: UserListResponse = await response.json();
      setUsers(data.users);
      setTotalPages(data.totalPages);
      setTotal(data.total);
    } catch (error) {
      console.error("Error fetching users:", error);
      toast({
        title: "Error",
        description: "Failed to load users",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, roleFilter, toast]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  // Calculate user counts from current data (approximate)
  const userCounts = {
    total: total,
    consultants: users.filter((u) => u.role === "CONSULTANT").length,
    consultees: users.filter((u) => u.role === "CONSULTEE").length,
    pending: users.filter((u) => u.onboardingCompleted === false).length,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            User Management
          </h1>
          <p className="text-zinc-500 dark:text-zinc-400">
            View and manage user accounts
          </p>
        </div>
        <Button variant="outline" onClick={fetchUsers} disabled={loading}>
          <RefreshCw
            className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`}
          />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950">
              <Users className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{total}</p>
              <p className="text-sm text-zinc-500">Total Users</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-purple-50 dark:bg-purple-950">
              <Shield className="h-5 w-5 text-purple-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{userCounts.consultants}</p>
              <p className="text-sm text-zinc-500">Consultants (page)</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950">
              <UserCheck className="h-5 w-5 text-emerald-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{userCounts.consultees}</p>
              <p className="text-sm text-zinc-500">Consultees (page)</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950">
              <UserX className="h-5 w-5 text-amber-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{userCounts.pending}</p>
              <p className="text-sm text-zinc-500">Pending (page)</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
              <Input
                placeholder="Search by name or email..."
                className="pl-9"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <Select
              value={roleFilter}
              onValueChange={(v) => {
                setRoleFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-full sm:w-40">
                <SelectValue placeholder="Role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Roles</SelectItem>
                <SelectItem value="CONSULTANT">Consultant</SelectItem>
                <SelectItem value="CONSULTEE">Consultee</SelectItem>
                <SelectItem value="STAFF">Staff</SelectItem>
                <SelectItem value="ADMIN">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Users Table */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-zinc-400" />
            </div>
          ) : users.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-zinc-500">
              <Users className="h-12 w-12 mb-4 text-zinc-300" />
              <p>No users found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="w-12"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow
                    key={user.id}
                    className="cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-900"
                    onClick={() => setSelectedUser(user)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar>
                          <AvatarImage src={user.image || ""} />
                          <AvatarFallback>
                            {(user.name || user.email || "?")
                              .split(" ")
                              .map((n) => n[0])
                              .join("")
                              .toUpperCase()
                              .slice(0, 2)}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <p className="font-medium flex items-center gap-1">
                            {user.name || "Unnamed"}
                            {user.onboardingCompleted && (
                              <CheckCircle className="h-3.5 w-3.5 text-blue-500" />
                            )}
                          </p>
                          <p className="text-sm text-zinc-500">{user.email}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={getRoleColor(user.role)}
                        variant="secondary"
                      >
                        {user.role?.toLowerCase() || "unknown"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={getStatusColor(user.onboardingCompleted)}
                        variant="secondary"
                      >
                        {getStatusText(user.onboardingCompleted)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-zinc-500">
                      {formatDate(user.createdAt)}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          asChild
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem>
                            <Eye className="h-4 w-4 mr-2" />
                            View Profile
                          </DropdownMenuItem>
                          <DropdownMenuItem>
                            <Mail className="h-4 w-4 mr-2" />
                            Send Email
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem>
                            <Flag className="h-4 w-4 mr-2" />
                            Flag Account
                          </DropdownMenuItem>
                          <DropdownMenuItem className="text-red-600">
                            <Ban className="h-4 w-4 mr-2" />
                            Suspend User
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-2">
          <Button
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </Button>
          <span className="flex items-center px-4 text-sm text-zinc-500">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      )}

      {/* User Detail Dialog */}
      <Dialog open={!!selectedUser} onOpenChange={() => setSelectedUser(null)}>
        <DialogContent className="max-w-2xl">
          {selectedUser && (
            <>
              <DialogHeader>
                <DialogTitle>User Details</DialogTitle>
                <DialogDescription>
                  View and manage user information
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-6">
                {/* Profile Header */}
                <div className="flex items-center gap-4 p-4 rounded-lg bg-zinc-50 dark:bg-zinc-900">
                  <Avatar className="h-16 w-16">
                    <AvatarImage src={selectedUser.image || ""} />
                    <AvatarFallback className="text-lg">
                      {(selectedUser.name || selectedUser.email || "?")
                        .split(" ")
                        .map((n) => n[0])
                        .join("")
                        .toUpperCase()
                        .slice(0, 2)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <h3 className="text-lg font-semibold flex items-center gap-2">
                      {selectedUser.name || "Unnamed"}
                      {selectedUser.onboardingCompleted && (
                        <CheckCircle className="h-4 w-4 text-blue-500" />
                      )}
                    </h3>
                    <div className="flex items-center gap-2 mt-1">
                      <Badge
                        className={getRoleColor(selectedUser.role)}
                        variant="secondary"
                      >
                        {selectedUser.role?.toLowerCase() || "unknown"}
                      </Badge>
                      <Badge
                        className={getStatusColor(
                          selectedUser.onboardingCompleted,
                        )}
                        variant="secondary"
                      >
                        {getStatusText(selectedUser.onboardingCompleted)}
                      </Badge>
                    </div>
                  </div>
                </div>

                {/* Contact Info */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-zinc-400" />
                    <span className="text-sm">
                      {selectedUser.email || "No email"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-zinc-400" />
                    <span className="text-sm">
                      {selectedUser.phone || "No phone"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-zinc-400" />
                    <span className="text-sm">
                      {selectedUser.city && selectedUser.country
                        ? `${selectedUser.city}, ${selectedUser.country}`
                        : "Location not set"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-zinc-400" />
                    <span className="text-sm">
                      Joined {formatDate(selectedUser.createdAt)}
                    </span>
                  </div>
                </div>

                {/* Stats */}
                <div className="grid gap-4 sm:grid-cols-3">
                  <Card>
                    <CardContent className="p-3 text-center">
                      <p className="text-2xl font-bold">-</p>
                      <p className="text-xs text-zinc-500">Total Bookings</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-3 text-center">
                      <p className="text-2xl font-bold">
                        {selectedUser.onboardingCompleted ? "Yes" : "No"}
                      </p>
                      <p className="text-xs text-zinc-500">Onboarding Done</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardContent className="p-3 text-center">
                      <p className="text-2xl font-bold">
                        {selectedUser.onboardingCompleted ? "Yes" : "No"}
                      </p>
                      <p className="text-xs text-zinc-500">Verified</p>
                    </CardContent>
                  </Card>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setSelectedUser(null)}>
                  Close
                </Button>
                <Button variant="outline">
                  <Mail className="h-4 w-4 mr-2" />
                  Contact User
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
