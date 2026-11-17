import { notFound } from "next/navigation";

/** An unknown back-office path 404s through `[tree]/not-found.tsx`, inside the operator shell. */
export default function BackofficeUnknownPath(): never {
  notFound();
}
