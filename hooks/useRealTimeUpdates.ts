import { useCallback, useEffect, useRef } from 'react';

export interface RealTimeUpdateData {
  type: 'REQUEST_UPDATE' | 'APPOINTMENT_UPDATE' | 'AVAILABILITY_UPDATE';
  consultantId?: string;
  requestId?: string;
  appointmentId?: string;
  data?: any;
  timestamp: number;
}

interface UseRealTimeUpdatesOptions {
  consultantId: string;
  onUpdate: (data: RealTimeUpdateData) => void;
  enabled?: boolean;
}

export function useRealTimeUpdates({
  consultantId,
  onUpdate,
  enabled = true,
}: UseRealTimeUpdatesOptions) {
  const eventSourceRef = useRef<EventSource | null>(null);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);
  const lastUpdateTimeRef = useRef<number>(0);

  // Setup Server-Sent Events connection
  const setupSSE = useCallback(() => {
    if (!enabled || eventSourceRef.current) return;

    try {
      const eventSource = new EventSource(
        `/api/realtime/consultants/${consultantId}/updates`
      );

      eventSource.onopen = () => {
        console.log('SSE connection established');
      };

      eventSource.onmessage = (event) => {
        try {
          const data: RealTimeUpdateData = JSON.parse(event.data);
          
          // Prevent duplicate processing of recent updates
          if (data.timestamp > lastUpdateTimeRef.current) {
            lastUpdateTimeRef.current = data.timestamp;
            
            // Broadcast to other tabs
            broadcastChannelRef.current?.postMessage(data);
            
            // Handle the update
            onUpdate(data);
          }
        } catch (error) {
          console.error('Error parsing SSE data:', error);
        }
      };

      eventSource.onerror = (error) => {
        console.error('SSE connection error:', error);
        
        // Attempt to reconnect after a delay
        setTimeout(() => {
          if (eventSourceRef.current?.readyState === EventSource.CLOSED) {
            setupSSE();
          }
        }, 5000);
      };

      eventSourceRef.current = eventSource;
    } catch (error) {
      console.error('Failed to setup SSE:', error);
    }
  }, [consultantId, enabled, onUpdate]);

  // Setup BroadcastChannel for cross-tab communication
  const setupBroadcastChannel = useCallback(() => {
    if (typeof window === 'undefined' || !enabled) return;

    try {
      const channel = new BroadcastChannel(`consultant-${consultantId}-updates`);
      
      channel.onmessage = (event) => {
        const data: RealTimeUpdateData = event.data;
        
        // Only process if it's a newer update than what we've seen
        if (data.timestamp > lastUpdateTimeRef.current) {
          lastUpdateTimeRef.current = data.timestamp;
          onUpdate(data);
        }
      };

      broadcastChannelRef.current = channel;
    } catch (error) {
      console.error('Failed to setup BroadcastChannel:', error);
    }
  }, [consultantId, enabled, onUpdate]);

  // Cleanup function
  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    if (broadcastChannelRef.current) {
      broadcastChannelRef.current.close();
      broadcastChannelRef.current = null;
    }
  }, []);

  // Setup connections
  useEffect(() => {
    if (!enabled) {
      cleanup();
      return;
    }

    setupSSE();
    setupBroadcastChannel();

    return cleanup;
  }, [enabled, setupSSE, setupBroadcastChannel, cleanup]);

  // Manual trigger for sending updates to other tabs
  const broadcastUpdate = useCallback((data: Omit<RealTimeUpdateData, 'timestamp'>) => {
    const updateData: RealTimeUpdateData = {
      ...data,
      timestamp: Date.now(),
    };

    broadcastChannelRef.current?.postMessage(updateData);
  }, []);

  return {
    broadcastUpdate,
    cleanup,
    isConnected: eventSourceRef.current?.readyState === EventSource.OPEN,
  };
} 