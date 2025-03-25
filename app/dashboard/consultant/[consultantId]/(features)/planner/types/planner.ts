import { ClassEvent, WebinarEvent } from './event';

export interface BasePlannerProps {
  isOpen: boolean;
  onClose: () => void;
  consultantId: string;
  isSaving?: boolean;
}

export interface WebinarPlannerProps extends BasePlannerProps {
  initialData?: WebinarEvent;
  onSave: (data: Partial<WebinarEvent>) => void;
}

export interface ClassPlannerProps extends BasePlannerProps {
  initialData?: ClassEvent;
  onSave: (data: Partial<ClassEvent>) => void;
} 