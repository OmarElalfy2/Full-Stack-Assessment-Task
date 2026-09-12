import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Paginated, TaskActivityEntry } from '@projectflow/shared';
import { TaskActivityType } from '@projectflow/shared';
import type { PaginationQueryDto } from '../common/dto/pagination.dto';
import { toUserSummaryOrDeleted } from '../common/utils/serialize';
import { ProjectAccessService } from '../projects/project-access.service';
import { Task, type TaskDocument } from '../tasks/schemas/task.schema';
import { UsersService } from '../users/users.service';
import { TaskActivity, type TaskActivityDocument } from './schemas/task-activity.schema';

@Injectable()
export class TaskActivityService {
  constructor(
    @InjectModel(TaskActivity.name)
    private readonly taskActivityModel: Model<TaskActivityDocument>,
    @InjectModel(Task.name) private readonly taskModel: Model<TaskDocument>,
    private readonly projectAccessService: ProjectAccessService,
    private readonly usersService: UsersService,
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

  /**
   * Paginated activity for one task, newest first. Deliberately looks the
   * task up via the `Task` model directly (rather than depending on
   * `TasksService`/`TasksModule`) to avoid a module import cycle, since
   * `TasksModule` already depends on this module for the write path above —
   * the same reason `TasksService` reaches into the `Comment` model directly
   * instead of depending on `CommentsModule`.
   */
  async findByTask(
    taskId: Types.ObjectId,
    userId: Types.ObjectId,
    query: PaginationQueryDto,
  ): Promise<Paginated<TaskActivityEntry>> {
    const task = await this.taskModel.findById(taskId).select('projectId').lean().exec();
    if (!task) {
      throw new NotFoundException('Task not found');
    }
    await this.projectAccessService.assertCanView(task.projectId, userId);

    const [activities, total] = await Promise.all([
      this.taskActivityModel
        .find({ taskId })
        .sort({ createdAt: -1 })
        .skip(query.skip)
        .limit(query.pageSize)
        .exec(),
      this.taskActivityModel.countDocuments({ taskId }),
    ]);

    return {
      items: await this.toEntries(activities),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** Resolves every actor/from/to id across the page in one batched query — no per-row lookup. */
  private async toEntries(activities: TaskActivityDocument[]): Promise<TaskActivityEntry[]> {
    if (activities.length === 0) {
      return [];
    }

    const userIds = new Map<string, Types.ObjectId>();
    for (const activity of activities) {
      userIds.set(activity.actorId.toString(), activity.actorId);
      if (activity.metadata.from) {
        userIds.set(activity.metadata.from.toString(), activity.metadata.from);
      }
      if (activity.metadata.to) {
        userIds.set(activity.metadata.to.toString(), activity.metadata.to);
      }
    }

    const users = await this.usersService.findManyByIds([...userIds.values()]);
    const usersById = new Map(users.map((user) => [user._id.toString(), user]));

    return activities.map((activity) => ({
      id: activity._id.toString(),
      taskId: activity.taskId.toString(),
      type: activity.type,
      actor: toUserSummaryOrDeleted(usersById.get(activity.actorId.toString())),
      metadata: {
        from: activity.metadata.from
          ? toUserSummaryOrDeleted(usersById.get(activity.metadata.from.toString()))
          : null,
        to: activity.metadata.to
          ? toUserSummaryOrDeleted(usersById.get(activity.metadata.to.toString()))
          : null,
      },
      createdAt: activity.createdAt.toISOString(),
    }));
  }
}
