"use client";

import { useState, useEffect } from "react";
import { Button } from "./ui/button";

const AnnouncementBar = () => {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const isClosed = localStorage.getItem("announcementBarClosed");
    if (isClosed === "true") {
      setIsVisible(false);
    }
  }, []);

  const handleClose = () => {
    localStorage.setItem("announcementBarClosed", "true");
    // Dispatch storage event for Navbar to detect
    window.dispatchEvent(new Event("storage"));
    setIsVisible(false);
  };

  if (!isVisible) return null;

  return (
    <div className="w-full bg-black text-white text-center py-2.5 fixed top-0 z-[1001] flex justify-center">
      🔥 Exciting sale coming soon! Get ready for amazing discounts on consultancy sessions! 🔥
      <Button
        style={{ color: "white", marginRight: "10px" }}
        onClick={handleClose}
      >
        X
      </Button>
    </div>
  );
};

export default AnnouncementBar;
