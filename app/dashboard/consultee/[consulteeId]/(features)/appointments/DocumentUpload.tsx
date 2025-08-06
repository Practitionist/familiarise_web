"use client";

import React, { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { Upload, FileText, X, AlertCircle, CheckCircle, Clock, Eye, Download, RefreshCw, WifiOff, Database, HelpCircle } from "lucide-react";

interface DocumentUploadProps {
  appointmentId: string;
  appointmentTitle: string;
  appointmentType: string;
}

interface UploadedDocument {
  id: string;
  originalName: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  fileUrl: string;
  description: string | null;
  reviewStatus: 'PENDING' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'NEEDS_REVISION';
  reviewNotes: string | null;
  reviewedAt: Date | null;
  uploadedAt: Date;
}

interface ApiError {
  error: string;
  message: string;
  code?: string;
  instructions?: string; // Manual bucket creation instructions
  technical?: string; // Technical error details
}

interface ApiResponse {
  data?: UploadedDocument[];
  message?: string;
  count?: number;
  appointmentTitle?: string;
  consultantName?: string;
  error?: string;
}

export function DocumentUpload({ appointmentId, appointmentTitle, appointmentType }: DocumentUploadProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [description, setDescription] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [documents, setDocuments] = useState<UploadedDocument[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [contextInfo, setContextInfo] = useState<{
    appointmentTitle?: string;
    consultantName?: string;
    message?: string;
  }>({});
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load existing documents when component mounts or dialog opens
  React.useEffect(() => {
    if (isOpen) {
      fetchDocuments();
    }
  }, [isOpen, appointmentId]);

  const fetchDocuments = async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`/api/appointments/${appointmentId}/documents`);
      const result: ApiResponse | ApiError = await response.json();
      
      if (!response.ok) {
        const errorResult = result as ApiError;
        setError(errorResult);
        
        // Show different toast messages based on error type
        if (errorResult.code === "NOT_FOUND") {
          toast({
            title: "Appointment not found",
            description: "Please check if you have the correct appointment selected.",
            variant: "destructive",
          });
        } else if (errorResult.code === "CONNECTION_ERROR") {
          toast({
            title: "Connection issue",
            description: "Please check your internet connection and try again.",
            variant: "destructive",
          });
        } else if (errorResult.code === "DATABASE_ERROR") {
          toast({
            title: "Service temporarily unavailable",
            description: "Please try again in a few moments.",
            variant: "destructive",
          });
        } else {
          toast({
            title: "Unable to load documents",
            description: errorResult.message || "Please try again later.",
            variant: "destructive",
          });
        }
        
        return;
      }
      
      const successResult = result as ApiResponse;
      setDocuments(successResult.data || []);
      setContextInfo({
        appointmentTitle: successResult.appointmentTitle,
        consultantName: successResult.consultantName,
        message: successResult.message
      });
      
      // Show informational message if no documents exist yet
      if (successResult.data?.length === 0 && successResult.message) {
        toast({
          title: "No documents yet",
          description: successResult.message,
        });
      }
      
    } catch (error) {
      console.error('Error fetching documents:', error);
      const networkError: ApiError = {
        error: "Network error",
        message: "Unable to connect to the server. Please check your internet connection and try again.",
        code: "NETWORK_ERROR"
      };
      setError(networkError);
      
      toast({
        title: "Connection failed",
        description: networkError.message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      // Client-side validation for immediate feedback
      if (file.size > 10 * 1024 * 1024) {
        toast({
          title: "File too large",
          description: `The selected file is ${Math.round(file.size / 1024 / 1024)}MB. Please select a file smaller than 10MB.`,
          variant: "destructive",
        });
        return;
      }

      // Check file type
      const allowedTypes = [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/gif',
        'text/plain',
      ];

      if (!allowedTypes.includes(file.type)) {
        toast({
          title: "Unsupported file type",
          description: `Please select a PDF, Word document, image (JPG, PNG, GIF), or text file. The file "${file.name}" is not supported.`,
          variant: "destructive",
        });
        return;
      }

      setSelectedFile(file);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) return;

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      if (description.trim()) {
        formData.append('description', description.trim());
      }

      const response = await fetch(`/api/appointments/${appointmentId}/documents`, {
        method: 'POST',
        body: formData,
      });

      const result: ApiResponse | ApiError = await response.json();

      if (!response.ok) {
        const errorResult = result as ApiError;
        
        // Show specific error messages based on error codes
        let toastTitle = "Upload failed";
        let toastDescription = errorResult.message;
        
        switch (errorResult.code) {
          case "FILE_TOO_LARGE":
            toastTitle = "File too large";
            break;
          case "UNSUPPORTED_FILE_TYPE":
            toastTitle = "Unsupported file type";
            break;
          case "NETWORK_ERROR":
            toastTitle = "Network error";
            break;
          case "STORAGE_ERROR":
            toastTitle = "Storage issue";
            break;
          case "BUCKET_NOT_FOUND":
            toastTitle = "Storage not configured";
            // For bucket errors, show a longer description with instructions
            if ('instructions' in errorResult) {
              toastDescription = `${errorResult.message}\n\n${errorResult.instructions}`;
            }
            break;
          case "NO_FILE":
            toastTitle = "No file selected";
            break;
          default:
            toastTitle = "Upload failed";
        }
        
        toast({
          title: toastTitle,
          description: toastDescription,
          variant: "destructive",
        });
        return;
      }

      const successResult = result as ApiResponse;
      
      toast({
        title: "Document uploaded successfully",
        description: successResult.message || `${selectedFile.name} has been uploaded and is ready for review.`,
      });

      // Reset form
      setSelectedFile(null);
      setDescription("");
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }

      // Refresh documents list
      fetchDocuments();
    } catch (error) {
      console.error('Error uploading file:', error);
      toast({
        title: "Network error",
        description: "Upload failed due to a connection issue. Please check your internet connection and try again.",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteDocument = async (documentId: string) => {
    try {
      const response = await fetch(`/api/appointments/${appointmentId}/documents/${documentId}`, {
        method: 'DELETE',
      });

      const result: ApiResponse | ApiError = await response.json();

      if (!response.ok) {
        const errorResult = result as ApiError;
        toast({
          title: "Delete failed",
          description: errorResult.message || "Failed to delete document. Please try again.",
          variant: "destructive",
        });
        return;
      }

      toast({
        title: "Document deleted",
        description: "Document has been deleted successfully",
      });

      // Refresh documents list
      fetchDocuments();
    } catch (error) {
      console.error('Error deleting document:', error);
      toast({
        title: "Network error",
        description: "Delete failed due to a connection issue. Please try again.",
        variant: "destructive",
      });
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'PENDING':
        return <Clock className="h-4 w-4 text-yellow-500" />;
      case 'IN_REVIEW':
        return <AlertCircle className="h-4 w-4 text-blue-500" />;
      case 'APPROVED':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'REJECTED':
        return <X className="h-4 w-4 text-red-500" />;
      case 'NEEDS_REVISION':
        return <AlertCircle className="h-4 w-4 text-orange-500" />;
      default:
        return <Clock className="h-4 w-4 text-gray-500" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'PENDING':
        return 'bg-yellow-100 text-yellow-800';
      case 'IN_REVIEW':
        return 'bg-blue-100 text-blue-800';
      case 'APPROVED':
        return 'bg-green-100 text-green-800';
      case 'REJECTED':
        return 'bg-red-100 text-red-800';
      case 'NEEDS_REVISION':
        return 'bg-orange-100 text-orange-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getErrorIcon = (errorCode?: string) => {
    switch (errorCode) {
      case "CONNECTION_ERROR":
      case "NETWORK_ERROR":
        return <WifiOff className="h-5 w-5" />;
      case "DATABASE_ERROR":
      case "STORAGE_ERROR":
        return <Database className="h-5 w-5" />;
      case "NOT_FOUND":
        return <HelpCircle className="h-5 w-5" />;
      default:
        return <AlertCircle className="h-5 w-5" />;
    }
  };

  const renderErrorState = () => {
    if (!error) return null;

    return (
      <Alert className="mb-4" variant="destructive">
        <div className="flex items-start space-x-2">
          {getErrorIcon(error.code)}
          <div className="flex-1">
            <AlertTitle className="text-sm font-medium">{error.error}</AlertTitle>
            <AlertDescription className="text-sm mt-1">
              {error.message}
            </AlertDescription>
            <div className="mt-3 flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={fetchDocuments}
                disabled={isLoading}
              >
                <RefreshCw className={`h-4 w-4 mr-1 ${isLoading ? 'animate-spin' : ''}`} />
                Try Again
              </Button>
              {error.code === "NOT_FOUND" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsOpen(false)}
                >
                  Close
                </Button>
              )}
            </div>
          </div>
        </div>
      </Alert>
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-200">
          <Upload className="h-4 w-4 mr-2" />
          Upload Documents
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-[90vw] sm:max-w-[500px] lg:max-w-[600px] max-h-[85vh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Upload Documents</DialogTitle>
          <DialogDescription>
            Upload documents for review for your {appointmentType.toLowerCase()}: {contextInfo.appointmentTitle || appointmentTitle}
            {contextInfo.consultantName && (
              <span className="block mt-1 text-sm text-gray-500">
                Consultant: {contextInfo.consultantName}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 sm:space-y-6">
          {renderErrorState()}

          {/* Upload New Document - Hide if there's a critical error */}
          {(!error || error.code !== "NOT_FOUND") && (
            <Card>
              <CardHeader className="pb-3 sm:pb-6">
                <CardTitle className="text-base sm:text-lg">Upload New Document</CardTitle>
                <CardDescription className="text-xs sm:text-sm">
                  Select a document to upload for review (PDF, Word, Images, Text files - Max 10MB)
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Input
                    ref={fileInputRef}
                    type="file"
                    onChange={handleFileSelect}
                    accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.gif,.txt"
                    className="cursor-pointer"
                    disabled={isUploading}
                  />
                </div>
                
                {selectedFile && (
                  <div className="bg-gray-50 p-3 rounded-lg">
                    <div className="flex items-center space-x-3">
                      <FileText className="h-8 w-8 text-blue-500" />
                                                <div className="flex-1 min-w-0">
                            <p className="text-xs sm:text-sm font-medium text-gray-900 truncate max-w-[200px] sm:max-w-none">
                              {selectedFile.name.length > 30 ? `${selectedFile.name.substring(0, 30)}...` : selectedFile.name}
                            </p>
                            <p className="text-xs sm:text-sm text-gray-500">
                              {formatFileSize(selectedFile.size)}
                            </p>
                          </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSelectedFile(null);
                          if (fileInputRef.current) fileInputRef.current.value = "";
                        }}
                        disabled={isUploading}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}

                <div>
                  <label className="text-xs sm:text-sm font-medium">Description (Optional)</label>
                  <Textarea
                    placeholder="Describe what this document is (e.g., Resume, ITR, Legal document, etc.)"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="mt-1 text-xs sm:text-sm"
                    disabled={isUploading}
                    rows={2}
                  />
                </div>

                <Button
                  onClick={handleUpload}
                  disabled={!selectedFile || isUploading}
                  className="w-full"
                >
                  {isUploading ? (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      Uploading...
                    </>
                  ) : (
                    "Upload Document"
                  )}
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Existing Documents */}
          <Card>
            <CardHeader className="pb-3 sm:pb-6">
              <CardTitle className="text-base sm:text-lg">Uploaded Documents</CardTitle>
              <CardDescription className="text-xs sm:text-sm">
                {contextInfo.message || "Documents you've uploaded for this appointment"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="text-center py-8">
                  <RefreshCw className="h-8 w-8 text-blue-600 mx-auto animate-spin mb-3" />
                  <p className="text-sm text-gray-500">Loading your documents...</p>
                </div>
              ) : error && error.code === "NOT_FOUND" ? (
                <div className="text-center py-8">
                  <HelpCircle className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                  <p className="text-sm text-gray-500 mb-2">Unable to load documents</p>
                  <p className="text-xs text-gray-400">Please check your appointment details</p>
                </div>
              ) : documents.length === 0 ? (
                <div className="text-center py-8">
                  <FileText className="h-12 w-12 text-gray-300 mx-auto mb-4" />
                  <p className="text-sm text-gray-500 mb-2">No documents uploaded yet</p>
                  <p className="text-xs text-gray-400">
                    Upload your first document to get feedback from {contextInfo.consultantName || 'your consultant'}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {documents.map((doc) => (
                    <div key={doc.id} className="border rounded-lg p-3 sm:p-4 hover:bg-gray-50 transition-colors">
                      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between space-y-3 sm:space-y-0">
                        <div className="flex items-start space-x-3 flex-1 min-w-0">
                          <FileText className="h-6 w-6 sm:h-8 sm:w-8 text-gray-400 flex-shrink-0 mt-1" />
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-xs sm:text-sm font-medium text-gray-900 truncate max-w-[180px] sm:max-w-[250px]">
                                {doc.originalName.length > 25 ? `${doc.originalName.substring(0, 25)}...` : doc.originalName}
                              </p>
                              <div className="flex items-center gap-1">
                                {getStatusIcon(doc.reviewStatus)}
                                <Badge variant="secondary" className={`${getStatusColor(doc.reviewStatus)} text-xs`}>
                                  {doc.reviewStatus.replace('_', ' ')}
                                </Badge>
                              </div>
                            </div>
                            {doc.description && (
                              <p className="text-sm text-gray-500 mt-1">{doc.description}</p>
                            )}
                            <div className="flex items-center space-x-4 mt-2 text-xs text-gray-400">
                              <span>{formatFileSize(doc.fileSize)}</span>
                              <span>Uploaded {new Date(doc.uploadedAt).toLocaleDateString()}</span>
                              {doc.reviewedAt && (
                                <span>Reviewed {new Date(doc.reviewedAt).toLocaleDateString()}</span>
                              )}
                            </div>
                            {doc.reviewNotes && (
                              <div className="mt-2 p-2 bg-blue-50 rounded text-sm border border-blue-200">
                                <p className="font-medium text-blue-800">Review Notes:</p>
                                <p className="text-blue-700">{doc.reviewNotes}</p>
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="flex space-x-1 ml-0 sm:ml-4 justify-end sm:justify-start">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => window.open(doc.fileUrl, '_blank')}
                            title="View document"
                            className="h-7 w-7 sm:h-9 sm:w-9 p-0"
                          >
                            <Eye className="h-3 w-3 sm:h-4 sm:w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              // Use our download API endpoint instead of direct Supabase URL
                              const downloadUrl = `/api/appointments/${appointmentId}/documents/${doc.id}/download`;
                              const link = document.createElement('a');
                              link.href = downloadUrl;
                              link.download = doc.originalName;
                              document.body.appendChild(link);
                              link.click();
                              document.body.removeChild(link);
                            }}
                            title="Download document"
                            className="h-7 w-7 sm:h-9 sm:w-9 p-0"
                          >
                            <Download className="h-3 w-3 sm:h-4 sm:w-4" />
                          </Button>
                          {doc.reviewStatus === 'PENDING' && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDeleteDocument(doc.id)}
                              className="text-red-600 hover:text-red-800 h-7 w-7 sm:h-9 sm:w-9 p-0"
                              title="Delete document (only available for pending documents)"
                            >
                              <X className="h-3 w-3 sm:h-4 sm:w-4" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setIsOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
} 