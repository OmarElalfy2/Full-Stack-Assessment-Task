import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';
import { TaskActivityType } from '@projectflow/shared';

export type TaskActivityDocument = HydratedDocument<TaskActivity>;

export interface TaskAssigneeChangedMetadata {
  from: Types.ObjectId | null;
  to: Types.ObjectId | null;
}

/**
 * An immutable log entry for a task change worth surfacing as history.
 * Records are append-only — there is no `updatedAt`, and nothing in this
 * module ever updates or deletes a row.
 */
@Schema({ collection: 'task_activities', timestamps: { createdAt: true, updatedAt: false } })
export class TaskActivity {
  @Prop({ type: Types.ObjectId, ref: 'Task', required: true, index: true })
  taskId: Types.ObjectId;

  @Prop({ type: String, enum: TaskActivityType, required: true })
  type: TaskActivityType;

  /** The user who performed the change. */
  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  actorId: Types.ObjectId;

  /**
   * Shape depends on `type`. Only `TASK_ASSIGNEE_CHANGED` exists today, so
   * this is typed to that; a second activity type would widen this to a
   * union keyed on `type`.
   */
  @Prop({
    type: {
      from: { type: Types.ObjectId, ref: 'User', default: null },
      to: { type: Types.ObjectId, ref: 'User', default: null },
    },
    required: true,
    _id: false,
  })
  metadata: TaskAssigneeChangedMetadata;

  createdAt: Date;
}

export const TaskActivitySchema = SchemaFactory.createForClass(TaskActivity);

/** Backs "newest activity first, scoped to one task" — the only query pattern this log serves. */
TaskActivitySchema.index({ taskId: 1, createdAt: -1 });
