import React from "react";
import styles from "../styles.module.css";

interface OptimizedMarqueeProps {
  children: React.ReactNode;
  direction?: "ltr" | "rtl";
  type: "featured" | "testimonials";
}

const OptimizedMarquee = React.memo(({ children, direction = "ltr", type }: OptimizedMarqueeProps) => {
  const containerClass = type === "featured" 
    ? styles.featuredMarqueeContainer 
    : styles.testimonialsMarqueeContainer;
    
  const trackClass = type === "featured" 
    ? styles.featuredMarqueeTrack
    : direction === "ltr" 
      ? styles.testimonialsMarqueeTrackLtr 
      : styles.testimonialsMarqueeTrackRtl;

  return (
    <div className={containerClass}>
      <div className={trackClass}>
        {children}
      </div>
    </div>
  );
});

OptimizedMarquee.displayName = "OptimizedMarquee";

export default OptimizedMarquee;