import { cn } from '@/lib/utils';
import type { HealthStatus } from '@/lib/types';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export interface HealthDotProps {
  status: HealthStatus;
  showLabel?: boolean;
  className?: string;
}

// `description` is the screen-reader / hover text. Idle gets an explicit
// "resting, normal" so it never reads as disabled or as a fault (ada a11y req).
const statusConfig: Record<HealthStatus, { color: string; label: string; description: string }> = {
  healthy: { color: 'bg-success', label: 'Healthy', description: 'Healthy — active' },
  // idle = alive but resting (recent daemon watchdog beat). Muted/neutral, not a
  // warning — a standby agent at idle is the normal state, never a fault.
  idle: { color: 'bg-muted-foreground/50', label: 'Idle', description: 'Idle — resting, normal' },
  stale: { color: 'bg-warning', label: 'Stale', description: 'Stale — no heartbeat' },
  down: { color: 'bg-destructive', label: 'Down', description: 'Down — no process' },
};

export function HealthDot({ status, showLabel = false, className }: HealthDotProps) {
  const config = statusConfig[status];

  return (
    <Tooltip>
      <TooltipTrigger
        className={cn('inline-flex items-center gap-1.5', className)}
      >
        <span
          // Colour is never the only carrier (ada a11y): the dot itself is
          // labelled for screen readers + native hover, and callers render a
          // visible text label alongside it wherever stale/down are labelled.
          role="img"
          aria-label={config.description}
          title={config.description}
          className={cn(
            'inline-block h-2.5 w-2.5 rounded-full',
            config.color,
            status === 'healthy' && 'animate-pulse-dot'
          )}
        />
        {showLabel && (
          <span className="text-xs text-muted-foreground">{config.label}</span>
        )}
      </TooltipTrigger>
      <TooltipContent>{config.description}</TooltipContent>
    </Tooltip>
  );
}
