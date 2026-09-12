'use client';

import { ClockCounterClockwiseIcon } from '@phosphor-icons/react/dist/ssr';
import { TaskActivityType, type TaskActivityEntry, type UserSummary } from '@projectflow/shared';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatRelativeTime } from '@/lib/format';
import { useTaskActivity } from '../hooks';

/**
 * Reads as plain history ("Ammar assigned Magd") rather than raw records
 * (`{ type: "TASK_ASSIGNEE_CHANGED", metadata: { from, to } }`), per Part
 * Ten of the brief. `describeActivity` is the translation layer between the
 * two.
 */
export function ActivityTimeline({ taskId }: { taskId: string }) {
  const { data, isPending, isError, error } = useTaskActivity(taskId);

  return (
    <section className="space-y-3" aria-label="Activity">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-foreground">Activity</h2>
        {data ? (
          <span className="rounded-sm bg-surface-strong px-1.5 text-[11px] text-muted-foreground">
            {data.total}
          </span>
        ) : null}
      </div>

      {isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : isError ? (
        <p className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-[13px] text-danger">
          {error.message}
        </p>
      ) : data.items.length === 0 ? (
        <EmptyState
          icon={ClockCounterClockwiseIcon}
          title="No activity yet"
          description="Changes to this task's assignee will show up here."
        />
      ) : (
        <ul className="space-y-2">
          {data.items.map((entry) => (
            <li key={entry.id} className="text-[13px] leading-5">
              <span className="text-muted-foreground">{describeActivity(entry)}</span>{' '}
              <span className="text-subtle-foreground">{formatRelativeTime(entry.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function describeActivity(entry: TaskActivityEntry): string {
  switch (entry.type) {
    case TaskActivityType.TASK_ASSIGNEE_CHANGED:
      return describeAssigneeChanged(entry);
    default:
      // Exhaustive today (one activity type exists); kept as a safe fallback
      // for whenever a second type is added.
      return `${entry.actor.name} updated this task`;
  }
}

function describeAssigneeChanged(entry: TaskActivityEntry): string {
  const { actor, metadata } = entry;

  const nameOrSelf = (user: UserSummary | null): string | null => {
    if (!user) {
      return null;
    }
    return user.id === actor.id ? 'themselves' : user.name;
  };

  const fromName = nameOrSelf(metadata.from);
  const toName = nameOrSelf(metadata.to);

  if (!metadata.from && metadata.to) {
    return `${actor.name} assigned ${toName}`;
  }

  if (metadata.from && !metadata.to) {
    return metadata.from.id === actor.id
      ? `${actor.name} removed the assignee`
      : `${actor.name} removed the assignee (previously ${fromName})`;
  }

  if (metadata.from && metadata.to) {
    return `${actor.name} changed the assignee from ${fromName} to ${toName}`;
  }

  return `${actor.name} updated the assignee`;
}
