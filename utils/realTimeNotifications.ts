// Import the broadcast function from the SSE route
import { broadcastToConsultant } from '@/app/api/realtime/consultants/[consultantId]/updates/route';

export interface NotificationData {
  type: 'REQUEST_UPDATE' | 'APPOINTMENT_UPDATE' | 'AVAILABILITY_UPDATE';
  requestId?: string;
  appointmentId?: string;
  data?: any;
}

/**
 * Trigger real-time notification for request updates
 */
export function notifyRequestUpdate(consultantId: string, requestId: string, data?: any) {
  broadcastToConsultant(consultantId, {
    type: 'REQUEST_UPDATE',
    requestId,
    data,
  });
}

/**
 * Trigger real-time notification for appointment updates
 */
export function notifyAppointmentUpdate(consultantId: string, appointmentId: string, data?: any) {
  broadcastToConsultant(consultantId, {
    type: 'APPOINTMENT_UPDATE',
    appointmentId,
    data,
  });
}

/**
 * Trigger real-time notification for availability updates
 */
export function notifyAvailabilityUpdate(consultantId: string, data?: any) {
  broadcastToConsultant(consultantId, {
    type: 'AVAILABILITY_UPDATE',
    data,
  });
}

/**
 * Generic notification function
 */
export function notifyConsultant(consultantId: string, notification: NotificationData) {
  broadcastToConsultant(consultantId, notification);
} 