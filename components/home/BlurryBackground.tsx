import React from "react";
import styles from "./BlurryBackground.module.css";

const BlurryBackground = React.memo(() => {
  return (
    <div className="absolute inset-0 -z-10 overflow-hidden bg-transparent">
      <div className={styles.heroBlobs}>
        <div className={`${styles.blob} ${styles.blob1}`} />
        <div className={`${styles.blob} ${styles.blob2}`} />
        <div className={`${styles.blob} ${styles.blob3}`} />
        <div className={`${styles.blob} ${styles.blob4}`} />
        <div className={`${styles.blob} ${styles.blob5}`} />
        <div className={`${styles.blob} ${styles.blob14}`} />
        <div className={`${styles.blob} ${styles.blob15}`} />
        <div className={`${styles.blob} ${styles.blob16}`} />
        <div className={`${styles.blob} ${styles.blob17}`} />
        <div className={`${styles.blob} ${styles.blob18}`} />
        <div className={`${styles.blob} ${styles.blob19}`} />
        <div className={`${styles.blob} ${styles.blob20}`} />
      </div>
      <div className={styles.sectionBlobs}>
        <div className={`${styles.blob} ${styles.blob6}`} />
        <div className={`${styles.blob} ${styles.blob7}`} />
        <div className={`${styles.blob} ${styles.blob8}`} />
        <div className={`${styles.blob} ${styles.blob9}`} />
        <div className={`${styles.blob} ${styles.blob10}`} />
        <div className={`${styles.blob} ${styles.blob21}`} />
        <div className={`${styles.blob} ${styles.blob22}`} />
        <div className={`${styles.blob} ${styles.blob23}`} />
        <div className={`${styles.blob} ${styles.blob24}`} />
        <div className={`${styles.blob} ${styles.blob25}`} />
        <div className={`${styles.blob} ${styles.blob26}`} />
        <div className={`${styles.blob} ${styles.blob27}`} />
        <div className={`${styles.blob} ${styles.blob28}`} />
        <div className={`${styles.blob} ${styles.blob29}`} />
        <div className={`${styles.blob} ${styles.blob30}`} />
        <div className={`${styles.blob} ${styles.blob31}`} />
        <div className={`${styles.blob} ${styles.blob32}`} />
      </div>
      <div className={styles.footerBlobs}>
        <div className={`${styles.blob} ${styles.blob11}`} />
        <div className={`${styles.blob} ${styles.blob12}`} />
        <div className={`${styles.blob} ${styles.blob13}`} />
        <div className={`${styles.blob} ${styles.blob33}`} />
        <div className={`${styles.blob} ${styles.blob34}`} />
        <div className={`${styles.blob} ${styles.blob35}`} />
        <div className={`${styles.blob} ${styles.blob36}`} />
        <div className={`${styles.blob} ${styles.blob37}`} />
        <div className={`${styles.blob} ${styles.blob38}`} />
        <div className={`${styles.blob} ${styles.blob39}`} />
        <div className={`${styles.blob} ${styles.blob40}`} />
        <div className={`${styles.blob} ${styles.blob41}`} />
        <div className={`${styles.blob} ${styles.blob42}`} />
        <div className={`${styles.blob} ${styles.blob43}`} />
        <div className={`${styles.blob} ${styles.blob44}`} />
        <div className={`${styles.blob} ${styles.blob45}`} />
      </div>
    </div>
  );
});

BlurryBackground.displayName = "BlurryBackground";

export default BlurryBackground;
