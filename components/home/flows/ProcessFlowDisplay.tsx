"use client";

import React from "react";
import { motion } from "framer-motion";
import { Check } from "lucide-react";

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
    <div className="relative pl-16">
      {/* Timeline Connector Line */}
      {!isLast && (
        <div className="absolute left-[27px] top-[68px] w-0.5 h-[calc(100%-8px)] bg-gradient-to-b from-white/40 via-white/20 to-white/5" />
      )}

      <motion.div
        className="relative group"
        initial={{ opacity: 0, x: -20 }}
        whileInView={{ opacity: 1, x: 0 }}
        transition={{
          duration: 0.5,
          delay: number * 0.1,
        }}
        viewport={{ once: true }}
      >
        {/* Large Circle Number */}
        <div className="absolute -left-16 top-3">
          <motion.div
            className="relative"
            whileHover={{ scale: 1.05 }}
            transition={{ type: "spring", stiffness: 400, damping: 25 }}
          >
            {/* Outer ring */}
            <div className="absolute inset-0 rounded-full border-2 border-white/20 group-hover:border-white/40 transition-colors duration-300" style={{ width: '56px', height: '56px' }} />

            {/* Inner circle with number */}
            <div className="relative w-14 h-14 rounded-full bg-white/10 backdrop-blur-md border border-white/30 flex items-center justify-center group-hover:bg-white/15 transition-all duration-300">
              <span className="text-2xl font-bold text-white">
                {number}
              </span>

              {/* Checkmark overlay on hover */}
              <motion.div
                className="absolute inset-0 rounded-full bg-white/20 flex items-center justify-center"
                initial={{ opacity: 0, scale: 0.5 }}
                whileHover={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.2 }}
              >
                <Check className="w-7 h-7 text-white" strokeWidth={3} />
              </motion.div>
            </div>

            {/* Pulsing ring effect */}
            <motion.div
              className="absolute inset-0 rounded-full border-2 border-white/30"
              animate={{
                scale: [1, 1.2, 1],
                opacity: [0.3, 0, 0.3],
              }}
              transition={{
                duration: 2,
                repeat: Infinity,
                ease: "easeInOut",
              }}
              style={{ width: '56px', height: '56px' }}
            />
          </motion.div>
        </div>

        {/* Content Card */}
        <motion.div
          className="bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 rounded-2xl p-5 transition-all duration-300 hover:shadow-2xl hover:shadow-white/5 min-h-[110px] flex flex-col justify-center"
          whileHover={{ x: 4 }}
        >
          <h4 className="text-base font-semibold text-white mb-1.5 leading-snug">
            {title}
          </h4>
          <p className="text-gray-300 text-xs leading-relaxed">
            {description}
          </p>
        </motion.div>
      </motion.div>
    </div>
  );
}
