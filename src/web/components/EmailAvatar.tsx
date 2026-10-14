import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { avatarClass, initialOf } from "../lib";

export function EmailAvatar({
  email,
  label,
  fallback,
  className,
}: {
  email?: string | null;
  label: string;
  fallback?: ReactNode;
  className?: string;
}) {
  const normalizedEmail = email?.trim().toLowerCase() ?? "";

  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold",
        avatarClass(normalizedEmail || label),
        className,
      )}
    >
      {fallback ?? initialOf(label)}
    </span>
  );
}
