"use client";

import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supportKeys } from "@/lib/support/support-keys";
import { humanizeEnum } from "@/lib/ui/tone";
import { cn } from "@/utils/tailwind";

const Users = z.object({
  users: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      role: z.string(),
    }),
  ),
});
export type FoundUser = z.infer<typeof Users>["users"][number];

/** Name or email search over `/api/admin/users`, so staff never paste raw user IDs. */
export function UserSearchCombobox({
  id,
  value,
  onChange,
}: Readonly<{
  id: string;
  value: FoundUser | null;
  onChange: (user: FoundUser | null) => void;
}>) {
  const listId = useId();
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const results = useQuery({
    queryKey: supportKeys.userSearch(search),
    enabled: search.length >= 2,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/users?search=${encodeURIComponent(search)}`,
      );
      if (!res.ok) throw new Error("User search failed");
      return Users.parse(await res.json()).users;
    },
  });
  const users = search.length >= 2 ? (results.data ?? []) : [];

  if (value)
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
        <span className="min-w-0 truncate">
          <span className="font-medium">{value.name ?? "Unnamed user"}</span>
          {value.email ? ` · ${value.email}` : ""}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            onChange(null);
            setText("");
          }}
        >
          Change
        </Button>
      </div>
    );

  const pick = (user: FoundUser) => {
    onChange(user);
    setOpen(false);
  };
  let status = "";
  if (search.length >= 2) {
    if (results.isFetching) status = "Searching…";
    else if (results.isError) status = "Search failed. Try again.";
    else if (users.length === 0) status = "No matching users.";
  }
  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={open && users.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && users[active] ? `${listId}-${users[active].id}` : undefined
        }
        autoComplete="off"
        value={text}
        placeholder="Search by name or email"
        onChange={(event) => {
          setText(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, Math.max(users.length - 1, 0)));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (event.key === "Enter" && open && users[active]) {
            event.preventDefault();
            pick(users[active]);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      <ul
        id={listId}
        role="listbox"
        aria-label="Matching users"
        hidden={!open || users.length === 0}
        className="absolute z-50 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-popover py-1 text-sm shadow-md"
      >
        {users.map((user, index) => (
          <li
            key={user.id}
            id={`${listId}-${user.id}`}
            role="option"
            aria-selected={index === active}
            className={cn(
              "cursor-pointer px-3 py-1.5",
              index === active && "bg-muted",
            )}
            onMouseDown={(event) => {
              event.preventDefault();
              pick(user);
            }}
          >
            <span className="font-medium">{user.name ?? "Unnamed user"}</span>
            <span className="text-muted-foreground">
              {" · "}
              {[user.email, humanizeEnum(user.role)]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </li>
        ))}
      </ul>
      <p aria-live="polite" className="mt-1 text-xs text-muted-foreground">
        {status}
      </p>
    </div>
  );
}
