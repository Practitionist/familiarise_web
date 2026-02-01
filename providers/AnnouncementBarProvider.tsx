"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
} from "react";

interface AnnouncementBarContextType {
  isVisible: boolean;
  height: number;
  setVisible: (visible: boolean) => void;
  setHeight: (height: number) => void;
}

const AnnouncementBarContext = createContext<AnnouncementBarContextType>({
  isVisible: false,
  height: 0,
  setVisible: () => {},
  setHeight: () => {},
});

export function AnnouncementBarProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isVisible, setIsVisible] = useState(false);
  const [height, setHeightState] = useState(0);

  const setVisible = useCallback((visible: boolean) => {
    setIsVisible(visible);
    if (!visible) {
      setHeightState(0);
      document.documentElement.style.setProperty(
        "--announcement-bar-height",
        "0px",
      );
    }
  }, []);

  const setHeight = useCallback((h: number) => {
    setHeightState(h);
    document.documentElement.style.setProperty(
      "--announcement-bar-height",
      `${h}px`,
    );
  }, []);

  const value = useMemo(
    () => ({ isVisible, height, setVisible, setHeight }),
    [isVisible, height, setVisible, setHeight],
  );

  return (
    <AnnouncementBarContext.Provider value={value}>
      {children}
    </AnnouncementBarContext.Provider>
  );
}

export function useAnnouncementBar() {
  return useContext(AnnouncementBarContext);
}
