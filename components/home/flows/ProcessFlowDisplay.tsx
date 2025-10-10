"use client";

import React from "react";
import { motion } from "framer-motion";

export interface ProcessFlowStepProps {
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly isLast?: boolean;
}

export function ProcessFlowDisplay({
  number,
  title,
  description,
  isLast = false,
}: ProcessFlowStepProps) {
  return (
    <div className="relative">
      <motion.div
        className="flex gap-6 items-start relative z-10 group p-6 rounded-2xl hover:bg-gray-800/30 backdrop-blur-sm transition-all duration-500"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        whileHover={{ x: 6 }}
      >
        <div className="flex-shrink-0 w-16 h-16 rounded-2xl bg-gradient-to-br from-gray-700 to-gray-800 border border-gray-600/50 flex items-center justify-center shadow-xl font-bold text-2xl text-gray-100 group-hover:scale-110 group-hover:shadow-2xl transition-all duration-500">
          {number}
        </div>
        <div className="flex-1 pt-2">
          <h4 className="font-semibold text-xl mb-2 text-gray-100 group-hover:text-white transition-colors">
            {title}
          </h4>
          <p className="text-gray-400 group-hover:text-gray-300 transition-colors leading-relaxed">
            {description}
          </p>
        </div>
      </motion.div>
      {!isLast && (
        <div className="absolute left-8 top-24 w-[3px] h-[calc(100%-1.5rem)] bg-gradient-to-b from-gray-600/50 via-gray-700/30 to-transparent rounded-full" />
      )}
    </div>
  );
}
