"use client";

import { User } from "@prisma/client";
import { createContext, useContext } from "react";

import type { ViewedPerson } from "@/lib/dashboard/operator-view";

interface UserContextType {
  /** The signed-in viewer: the learner, or an operator inspecting them. */
  userDetails: User | null;
  /** The learner whose dashboard the route opens. */
  learner: ViewedPerson | null;
}

export const UserContext = createContext<UserContextType>({
  userDetails: null,
  learner: null,
});

export function useUser() {
  return useContext(UserContext);
}

export function UserProvider({
  children,
  userDetails,
  learner,
}: {
  children: React.ReactNode;
  userDetails: User | null;
  learner: ViewedPerson | null;
}) {
  return (
    <UserContext.Provider value={{ userDetails, learner }}>
      {children}
    </UserContext.Provider>
  );
}
