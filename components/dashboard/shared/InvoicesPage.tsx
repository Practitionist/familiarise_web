"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { FileText, Download, Search } from "lucide-react";

interface Invoice {
  id: string;
  invoiceNumber: string;
  paymentIntent: string;
  amount: number;
  currency: string;
  status: string;
  gateway: string;
  userName: string;
  userEmail: string;
  appointmentType?: string;
  consultantName?: string;
  createdAt: string;
  paidAt?: string;
}

interface InvoicesPageProps {
  apiEndpoint: string;
  title?: string;
  description?: string;
  showExport?: boolean;
  queryKeyPrefix?: string;
}

async function fetchInvoices(
  apiEndpoint: string,
  page: number,
  limit: number,
  search?: string
) {
  const offset = (page - 1) * limit;
  const params = new URLSearchParams({
    limit: limit.toString(),
    offset: offset.toString(),
  });
  if (search) params.set("search", search);

  const response = await fetch(`${apiEndpoint}?${params}`);
  if (!response.ok) {
    throw new Error("Failed to fetch invoices");
  }
  return response.json();
}

export function InvoicesPage({
  apiEndpoint,
  title = "Invoices",
  description = "View all platform payment invoices",
  showExport = true,
  queryKeyPrefix = "invoices",
}: InvoicesPageProps) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const limit = 20;

  const { data, isLoading, error } = useQuery({
    queryKey: [queryKeyPrefix, page, search],
    queryFn: () => fetchInvoices(apiEndpoint, page, limit, search),
    staleTime: 60 * 1000,
  });

  const handleSearch = () => {
    setSearch(searchInput);
    setPage(1);
  };

  const exportToCSV = () => {
    if (!data?.invoices?.length) return;

    const headers = [
      "Invoice Number",
      "Customer",
      "Email",
      "Amount",
      "Currency",
      "Gateway",
      "Type",
      "Consultant",
      "Date",
    ];
    const rows = data.invoices.map((inv: Invoice) => [
      inv.invoiceNumber,
      inv.userName,
      inv.userEmail,
      (inv.amount / 100).toFixed(2),
      inv.currency,
      inv.gateway,
      inv.appointmentType || "",
      inv.consultantName || "",
      new Date(inv.createdAt).toISOString(),
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map((r: string[]) => r.map((c) => `"${c}"`).join(",")),
    ].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `invoices-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-red-600">Error</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-gray-700">
              {error instanceof Error
                ? error.message
                : "Failed to load invoices"}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">{title}</h1>
          <p className="text-gray-600 mt-1">{description}</p>
        </div>
        {showExport && (
          <Button variant="outline" onClick={exportToCSV}>
            <Download className="w-4 h-4 mr-2" />
            Export CSV
          </Button>
        )}
      </div>

      {/* Search */}
      <Card>
        <CardContent className="pt-4">
          <div className="flex gap-2">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
              <Input
                placeholder="Search by name, email, or payment ID..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                className="pl-10"
              />
            </div>
            <Button onClick={handleSearch}>Search</Button>
            {search && (
              <Button
                variant="ghost"
                onClick={() => {
                  setSearch("");
                  setSearchInput("");
                  setPage(1);
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <FileText className="w-5 h-5 text-blue-600" />
            Invoices ({data?.pagination?.total || 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : data?.invoices?.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Invoice
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Customer
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Amount
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Gateway
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Type
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                        Date
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {data.invoices.map((invoice: Invoice) => (
                      <tr key={invoice.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <p className="text-sm font-mono font-medium text-gray-900">
                            {invoice.invoiceNumber}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <div>
                            <p className="text-sm font-medium text-gray-900">
                              {invoice.userName}
                            </p>
                            <p className="text-xs text-gray-500">
                              {invoice.userEmail}
                            </p>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm font-semibold text-gray-900">
                          {(invoice.amount / 100).toLocaleString("en-IN", {
                            style: "currency",
                            currency: invoice.currency,
                          })}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-700">
                          {invoice.gateway}
                        </td>
                        <td className="px-4 py-3">
                          <div>
                            <p className="text-sm text-gray-700">
                              {invoice.appointmentType || "N/A"}
                            </p>
                            {invoice.consultantName && (
                              <p className="text-xs text-gray-500">
                                with {invoice.consultantName}
                              </p>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">
                          {new Date(invoice.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {data?.pagination && (
                <div className="flex items-center justify-between pt-4">
                  <div className="text-sm text-gray-500">
                    Showing {(page - 1) * limit + 1} to{" "}
                    {Math.min(page * limit, data.pagination.total)} of{" "}
                    {data.pagination.total} invoices
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page === 1}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => p + 1)}
                      disabled={!data.pagination.hasMore}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-12">
              <p className="text-gray-500">
                {search ? "No invoices match your search" : "No invoices found"}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
