"use client"

import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export default function PolicyTab() {
  return (
    <div className="min-h-[calc(100vh-200px)] space-y-6 overflow-y-auto">
      <h2 className="text-3xl font-bold mb-6">Policies</h2>
      
      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Terms of Service</CardTitle>
        </CardHeader>
        <CardContent>
          <p>This is a placeholder for the Terms of Service. The actual content should be provided by the legal team.</p>
        </CardContent>
      </Card>

      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Privacy Policy</CardTitle>
        </CardHeader>
        <CardContent>
          <p>This is a placeholder for the Privacy Policy. The actual content should be provided by the legal team.</p>
        </CardContent>
      </Card>

      <Card className="bg-white">
        <CardHeader>
          <CardTitle>Refund Policy</CardTitle>
        </CardHeader>
        <CardContent>
          <p>This is a placeholder for the Refund Policy. The actual content should be provided by the finance team.</p>
        </CardContent>
      </Card>
    </div>
  );
}