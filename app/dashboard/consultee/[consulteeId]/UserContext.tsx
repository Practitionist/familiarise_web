"use client";

import { User } from "@prisma/client";
import { createContext, useContext } from "react";

interface UserContextType {
  userDetails: User | null;
}

export const UserContext = createContext<UserContextType>({
  userDetails: null,
});

export function useUser() {
  return useContext(UserContext);
}

export function UserProvider({
  children,
  userDetails,
}: {
  children: React.ReactNode;
  userDetails: User | null;
}) {
  return (
    <UserContext.Provider value={{ userDetails }}>
      {children}
    </UserContext.Provider>
  );
}
