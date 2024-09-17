import { useState, useCallback } from 'react';
import { navigateCalendar } from '../utils';

export const useCalendarNavigation = () => {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useState<'week' | 'month'>('week');

  const navigate = useCallback((direction: 'prev' | 'next') => {
    setCurrentDate(prev => navigateCalendar(prev, view, direction));
  }, [view]);

  return {
    currentDate,
    view,
    setView,
    navigate,
  };
};