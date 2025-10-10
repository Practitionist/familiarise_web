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
        className="flex gap-6 items-start relative z-10 group p-6 rounded-2xl hover:bg-gray-800/40 backdrop-blur-sm transition-all duration-500"
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        whileHover={{ x: 8, y: -2 }}
      >
        <div className="relative flex-shrink-0">
          {/* Badge with silver gradient and glow */}
          <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-gray-600 via-gray-700 to-gray-800 border border-gray-500/50 flex items-center justify-center shadow-2xl font-bold text-3xl text-gray-100 group-hover:scale-110 group-hover:border-gray-400/60 group-hover:shadow-gray-400/20 transition-all duration-500">
            {number}
          </div>
          {/* Silver glow effect on hover */}
          <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-gray-400/0 to-gray-500/0 group-hover:from-gray-400/10 group-hover:to-gray-500/5 blur-xl transition-all duration-500" />
        </div>
        <div className="flex-1 pt-3">
          <h4 className="font-semibold text-xl mb-2 text-gray-100 group-hover:text-white transition-colors">
            {title}
          </h4>
          <p className="text-gray-400 group-hover:text-gray-300 transition-colors leading-relaxed">
            {description}
          </p>
        </div>
      </motion.div>
      {!isLast && (
        <div className="absolute left-10 top-28 w-[3px] h-[calc(100%-2rem)] pointer-events-none">
          {/* Silver-tinted connecting line with glow */}
          <div className="absolute inset-0 bg-gradient-to-b from-gray-500/40 via-gray-600/25 to-transparent rounded-full" />
          <div className="absolute inset-0 bg-gradient-to-b from-gray-400/20 via-gray-500/10 to-transparent rounded-full blur-sm" />
        </div>
      )}
    </div>
  );
}
