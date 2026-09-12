import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { TaskActivityType } from '@projectflow/shared';
import { TaskActivity, type TaskActivityDocument } from './schemas/task-activity.schema';

@Injectable()
export class TaskActivityService {
  constructor(
    @InjectModel(TaskActivity.name)
    private readonly taskActivityModel: Model<TaskActivityDocument>,
  ) {}

  /**
   * Records one `TASK_ASSIGNEE_CHANGED` entry. Covers all three transitions
   * from Part Seven of the brief — unassigned -> assigned, assigned ->
   * different user, and assigned -> unassigned — since `from`/`to` are each
   * independently nullable. Callers are expected to only call this once
   * they've confirmed `from` and `to` actually differ; this service does not
   * re-check that, since deciding *whether* something changed is a task
   * business rule, not an activity-log concern.
   */
  recordAssigneeChanged(
    taskId: Types.ObjectId,
    actorId: Types.ObjectId,
    from: Types.ObjectId | null,
    to: Types.ObjectId | null,
  ): Promise<TaskActivityDocument> {
    return this.taskActivityModel.create({
      taskId,
      type: TaskActivityType.TASK_ASSIGNEE_CHANGED,
      actorId,
      metadata: { from, to },
    });
  }
}
