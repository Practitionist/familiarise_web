import React from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { FileEditIcon, DeleteIcon, DownloadIcon } from '../../../../assets/icons';

interface Document {
  invoiceNo: string;
  clientName: string;
  title: string;
  tag: string;
}

interface DocumentReviewTableProps {
  documents: Document[];
}

export const DocumentReviewTable: React.FC<DocumentReviewTableProps> = ({ documents }) => (
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead className="w-[100px]">Invoice No.</TableHead>
        <TableHead>Client Name</TableHead>
        <TableHead>Document Title</TableHead>
        <TableHead>Tags</TableHead>
        <TableHead>Actions</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {documents.map((doc) => (
        <TableRow key={doc.invoiceNo}>
          <TableCell className="font-medium">{doc.invoiceNo}</TableCell>
          <TableCell>{doc.clientName}</TableCell>
          <TableCell>{doc.title}</TableCell>
          <TableCell>
            <Badge variant="secondary">{doc.tag}</Badge>
          </TableCell>
          <TableCell className="flex space-x-2">
            <FileEditIcon className="text-gray-500" />
            <DeleteIcon className="text-gray-500" />
            <DownloadIcon className="text-gray-500" />
          </TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);