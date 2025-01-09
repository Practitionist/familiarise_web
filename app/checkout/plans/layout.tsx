"use client";

import { motion } from "framer-motion";

export default function CheckoutLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
      className="grid min-h-screen w-full overflow-hidden lg:grid-cols-[60%_40%]"
    >
      {children}
    </motion.div>
  );
}
