import { NextRequest, NextResponse } from 'next/server';

// Store active connections
const connections = new Map<string, WritableStreamDefaultWriter>();

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ consultantId: string }> }
) {
  const resolvedParams = await params;
  const consultantId = resolvedParams.consultantId;

  // Create readable stream for SSE
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      
      // Send initial connection message
      const initialMessage = {
        type: 'CONNECTION_ESTABLISHED',
        consultantId,
        timestamp: Date.now(),
      };
      
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify(initialMessage)}\n\n`)
      );

      // Store connection for broadcasting
      const connectionId = `${consultantId}-${Date.now()}`;
      
      // Create a writer for this connection
      const writer = controller;
      
      // Store connection reference
      connections.set(connectionId, writer as any);

      // Send heartbeat every 30 seconds to keep connection alive
      const heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`data: {"type":"heartbeat","timestamp":${Date.now()}}\n\n`));
        } catch (error) {
          clearInterval(heartbeatInterval);
          connections.delete(connectionId);
        }
      }, 30000);

      // Cleanup on close
      request.signal.addEventListener('abort', () => {
        clearInterval(heartbeatInterval);
        connections.delete(connectionId);
        try {
          controller.close();
        } catch (error) {
          // Connection already closed
        }
      });
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control',
    },
  });
}

// Function to broadcast updates to all connected clients for a consultant
export function broadcastToConsultant(
  consultantId: string, 
  data: {
    type: 'REQUEST_UPDATE' | 'APPOINTMENT_UPDATE' | 'AVAILABILITY_UPDATE';
    requestId?: string;
    appointmentId?: string;
    data?: any;
  }
) {
  const encoder = new TextEncoder();
  const message = {
    ...data,
    consultantId,
    timestamp: Date.now(),
  };

  const eventData = `data: ${JSON.stringify(message)}\n\n`;
  const encodedData = encoder.encode(eventData);

  // Send to all connections for this consultant
  connections.forEach((writer, connectionId) => {
    if (connectionId.startsWith(consultantId)) {
      try {
        (writer as any).enqueue(encodedData);
      } catch (error) {
        // Connection is dead, remove it
        connections.delete(connectionId);
      }
    }
  });
} 