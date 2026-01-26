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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Search,
  Users,
  UserCheck,
  UserX,
  Shield,
  MoreHorizontal,
  Eye,
  Mail,
  Flag,
  Ban,
  CheckCircle,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { UserDetailModal } from "@/components/admin/UserDetailModal";
import { VerificationQueue } from "@/components/admin/VerificationQueue";

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

interface ModerationStats {
  pendingProfiles: number;
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
  return new Date(dateString).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

export default function UserManagementPage() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("all-users");
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

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

  const fetchPendingCount = useCallback(async () => {
    try {
      const response = await fetch("/api/staff/moderation/stats");
      if (response.ok) {
        const data: ModerationStats = await response.json();
        setPendingCount(data.pendingProfiles || 0);
      }
    } catch (error) {
      console.error("Error fetching pending count:", error);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    fetchPendingCount();
  }, [fetchPendingCount]);

  // Calculate user counts from current data
  const userCounts = {
    total: total,
    consultants: users.filter((u) => u.role === "CONSULTANT").length,
    consultees: users.filter((u) => u.role === "CONSULTEE").length,
    pending: users.filter((u) => u.onboardingCompleted === false).length,
  };

  const handleViewUser = (userId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedUserId(userId);
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

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="all-users" className="gap-2">
            <Users className="h-4 w-4" />
            All Users
          </TabsTrigger>
          <TabsTrigger value="pending-verification" className="gap-2">
            <ShieldCheck className="h-4 w-4" />
            Pending Verification
            {pendingCount > 0 && (
              <Badge
                variant="secondary"
                className="ml-1 bg-amber-100 text-amber-700"
              >
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* All Users Tab */}
        <TabsContent value="all-users" className="space-y-4">
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
                        onClick={(e) => handleViewUser(user.id, e)}
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
                              <p className="text-sm text-zinc-500">
                                {user.email}
                              </p>
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
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                              >
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={(e) => handleViewUser(user.id, e)}
                              >
                                <Eye className="h-4 w-4 mr-2" />
                                View Details
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
        </TabsContent>

        {/* Pending Verification Tab */}
        <TabsContent value="pending-verification">
          <VerificationQueue apiBasePath="/api/staff/moderation/profiles" />
        </TabsContent>
      </Tabs>

      {/* User Detail Modal */}
      <UserDetailModal
        userId={selectedUserId}
        open={!!selectedUserId}
        onOpenChange={(open) => !open && setSelectedUserId(null)}
      />
    </div>
  );
}
