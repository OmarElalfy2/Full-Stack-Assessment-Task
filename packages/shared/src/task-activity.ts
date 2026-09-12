/**
 * Kinds of task activity the system records. Only assignee changes are
 * tracked today (per the assessment scope), but the type is a distinct enum
 * rather than a single boolean/string so the log can grow (status changes,
 * comments, etc.) without a breaking shape change.
 */
export enum TaskActivityType {
  TASK_ASSIGNEE_CHANGED = 'TASK_ASSIGNEE_CHANGED',
}
