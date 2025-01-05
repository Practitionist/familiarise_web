import { useState, useCallback } from "react";

type View = "week" | "month";
type Direction = "prev" | "next";

export function useCalendarNavigation() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [view, setView] = useState<View>("week");

  const navigate = useCallback(
    (direction: Direction) => {
      setCurrentDate((prevDate) => {
        const newDate = new Date(prevDate);
        if (view === "week") {
          newDate.setDate(prevDate.getDate() + (direction === "next" ? 7 : -7));
        } else {
          newDate.setMonth(
            prevDate.getMonth() + (direction === "next" ? 1 : -1),
          );
        }
        return newDate;
      });
    },
    [view],
  );

  return {
    currentDate,
    view,
    setView,
    navigate,
  };
}
