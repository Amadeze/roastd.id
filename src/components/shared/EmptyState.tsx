import { Package, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TableRow, TableCell } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  // Content
  label: string;
  description?: string;
  // Action
  action?: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  actionVariant?: "default" | "outline" | "ghost";
  actionIcon?: React.ReactNode;
  // Icon
  icon?: React.ReactNode;
  // Layout
  variant?: "card" | "table" | "inline";
  // Table specific
  colSpan?: number;
  // Filter state
  isFiltered?: boolean;
  filteredLabel?: string;
  filteredDescription?: string;
  // Styling
  className?: string;
  // Inline variant (for compact inline usage)
  inline?: boolean;
}

export function EmptyState({
  label,
  description,
  action,
  actionLabel,
  onAction,
  actionVariant = "default",
  actionIcon,
  icon,
  variant = "card",
  colSpan,
  isFiltered = false,
  filteredLabel,
  filteredDescription,
  className,
  inline = false,
}: EmptyStateProps) {
  // Action button
  const actionButton = action || (actionLabel && onAction ? (
    <Button
      size="sm"
      variant={actionVariant}
      onClick={onAction}
      className="gap-1.5"
    >
      {actionIcon}
      {actionLabel}
    </Button>
  ) : null);

  // Render based on variant
  if (variant === "table") {
    return (
      <TableRow>
        <TableCell
          colSpan={colSpan || 10}
          className={cn("py-12 text-center", className)}
        >
          {inline ? (
            <div className="flex items-center justify-center gap-3">
              <p className="text-sm font-medium text-muted-foreground">
                {isFiltered ? (filteredLabel || `Tidak ada ${label.toLowerCase()} yang cocok.`) : `Belum ada ${label.toLowerCase()}`}
              </p>
              {actionButton}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <p className="text-sm font-medium text-muted-foreground">
                {isFiltered
                  ? (filteredLabel || `Tidak ada ${label.toLowerCase()} yang cocok.`)
                  : `Belum ada ${label}`}
              </p>
              {description && !isFiltered && (
                <p className="mt-1 text-xs text-muted-foreground">{description}</p>
              )}
              {isFiltered && filteredDescription && (
                <p className="mt-1 text-xs text-muted-foreground">{filteredDescription}</p>
              )}
              {actionButton && <div className="mt-3">{actionButton}</div>}
            </div>
          )}
        </TableCell>
      </TableRow>
    );
  }

  if (variant === "inline") {
    return (
      <div className={cn("flex items-center justify-center gap-3 py-4", className)}>
        <p className="text-sm font-medium text-muted-foreground">
          {isFiltered ? (filteredLabel || `Tidak ada ${label.toLowerCase()} yang cocok.`) : `Belum ada ${label.toLowerCase()}`}
        </p>
        {actionButton}
      </div>
    );
  }

  // Card variant (default)
  return (
    <div className={cn(
      "flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-border bg-surface-sunken/50 px-6 py-12 text-center",
      variant === "card" && "bg-surface-sunken/50",
      className
    )}>
      <div className="flex size-11 items-center justify-center rounded-full border border-border bg-card text-ink-tertiary">
        {icon || <Package size={18} />}
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="font-heading text-sm font-bold text-foreground">
          {isFiltered ? (filteredLabel || `Tidak ada ${label.toLowerCase()} yang cocok.`) : label}
        </p>
        {(description && !isFiltered) && (
          <p className="max-w-sm text-xs leading-5 text-muted-foreground">{description}</p>
        )}
        {isFiltered && filteredDescription && (
          <p className="max-w-sm text-xs leading-5 text-muted-foreground">{filteredDescription}</p>
        )}
      </div>
      {actionButton && <div className="mt-2">{actionButton}</div>}
    </div>
  );
}

// Convenience helpers for common patterns
export function TableEmptyState({
  label,
  isFiltered,
  filteredLabel,
  filteredDescription,
  actionLabel,
  onAction,
  actionIcon,
  colSpan,
}: {
  label: string;
  isFiltered?: boolean;
  filteredLabel?: string;
  filteredDescription?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionIcon?: React.ReactNode;
  colSpan?: number;
}) {
  return (
    <EmptyState
      variant="table"
      label={label}
      isFiltered={isFiltered}
      filteredLabel={filteredLabel}
      filteredDescription={filteredDescription}
      actionLabel={actionLabel}
      onAction={onAction}
      actionIcon={actionIcon || <Plus size={12} />}
      colSpan={colSpan || 10}
    />
  );
}

export function CardEmptyState({
  label,
  description,
  actionLabel,
  onAction,
  icon,
}: {
  label: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <EmptyState
      variant="card"
      label={label}
      description={description}
      actionLabel={actionLabel}
      onAction={onAction}
      icon={icon}
    />
  );
}

export function InlineEmptyState({
  label,
  isFiltered,
  filteredLabel,
  actionLabel,
  onAction,
}: {
  label: string;
  isFiltered?: boolean;
  filteredLabel?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <EmptyState
      variant="inline"
      label={label}
      isFiltered={isFiltered}
      filteredLabel={filteredLabel}
      actionLabel={actionLabel}
      onAction={onAction}
      actionIcon={<Plus size={12} />}
    />
  );
}

EmptyState.TableEmptyState = TableEmptyState;
EmptyState.InlineEmptyState = InlineEmptyState;
EmptyState.CardEmptyState = CardEmptyState;

// Re-export the shared EmptyState as default for backward compatibility
export { EmptyState as SharedEmptyState };