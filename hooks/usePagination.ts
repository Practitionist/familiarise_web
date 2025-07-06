"use client";

import { useState, useMemo } from "react";

interface PaginationConfig {
  pageSize?: number;
  initialPage?: number;
}

export function usePagination<T>(
  data: T[], 
  config: PaginationConfig = {}
) {
  const { pageSize = 10, initialPage = 1 } = config;
  const [currentPage, setCurrentPage] = useState(initialPage);

  const paginatedData = useMemo(() => {
    const startIndex = (currentPage - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    return data.slice(startIndex, endIndex);
  }, [data, currentPage, pageSize]);

  const totalPages = Math.ceil(data.length / pageSize);
  const hasNextPage = currentPage < totalPages;
  const hasPreviousPage = currentPage > 1;

  const goToPage = (page: number) => {
    if (page >= 1 && page <= totalPages) {
      setCurrentPage(page);
    }
  };

  const goToNextPage = () => {
    if (hasNextPage) {
      setCurrentPage(currentPage + 1);
    }
  };

  const goToPreviousPage = () => {
    if (hasPreviousPage) {
      setCurrentPage(currentPage - 1);
    }
  };

  const goToFirstPage = () => {
    setCurrentPage(1);
  };

  const goToLastPage = () => {
    setCurrentPage(totalPages);
  };

  return {
    // Data
    paginatedData,
    totalItems: data.length,
    totalPages,
    currentPage,
    pageSize,
    
    // Status
    hasNextPage,
    hasPreviousPage,
    isEmpty: data.length === 0,
    
    // Actions
    goToPage,
    goToNextPage,
    goToPreviousPage,
    goToFirstPage,
    goToLastPage,
    
    // Computed values
    startIndex: (currentPage - 1) * pageSize + 1,
    endIndex: Math.min(currentPage * pageSize, data.length),
  };
}