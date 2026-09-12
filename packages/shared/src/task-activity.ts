import type { UserSummary } from './api';

/**
 * Kinds of task activity the system records. Only assignee changes are
 * tracked today (per the assessment scope), but the type is a distinct enum
 * rather than a single boolean/string so the log can grow (status changes,
 * comments, etc.) without a breaking shape change.
 */
export enum TaskActivityType {
  TASK_ASSIGNEE_CHANGED = 'TASK_ASSIGNEE_CHANGED',
}

/**
 * `metadata` is typed for `TASK_ASSIGNEE_CHANGED` specifically; a second
 * activity type would widen this to a union keyed on `type`. Users are
 * resolved server-side (rather than left as raw ids) so the frontend never
 * needs a second round-trip to render "X assigned Y" style history.
 */
export interface TaskActivityEntry {
  id: string;
  taskId: string;
  type: TaskActivityType;
  actor: UserSummary;
  metadata: {
    from: UserSummary | null;
    to: UserSummary | null;
  };
  createdAt: string;
}
