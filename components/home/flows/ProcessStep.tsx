"use client";

import React from "react";
import { motion } from "framer-motion";

export interface ProcessStepProps {
  number: number;
  title: string;
  description: string;
  isLast?: boolean;
}

export function ProcessStep({
  number,
  title,
  description,
  isLast = false,
}: ProcessStepProps) {
  return (
    <div className="relative">
      <motion.div
        className="flex gap-4 items-start relative z-10 group hover:bg-accent/50 p-4 rounded-lg transition-all duration-300"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        whileHover={{ x: 4 }}
      >
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gradient-to-br from-primary to-primary/80 text-white flex items-center justify-center shadow-md font-medium">
          {number}
        </div>
        <div>
          <h4 className="font-semibold text-lg group-hover:text-primary transition-colors">
            {title}
          </h4>
          <p className="text-muted-foreground group-hover:text-foreground/80 transition-colors">
            {description}
          </p>
        </div>
      </motion.div>
      {!isLast && (
        <div className="absolute left-9 top-14 w-[2px] h-[calc(100%-0.5rem)] bg-gradient-to-b from-primary/30 to-transparent" />
      )}
    </div>
  );
}
