import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type FilterQuery, Model, Types } from 'mongoose';
import type { Paginated, TaskDetail, TaskSummary } from '@projectflow/shared';
import { toObjectId } from '../common/utils/object-id';
import { toUserSummary } from '../common/utils/serialize';
import { Comment, type CommentDocument } from '../comments/schemas/comment.schema';
import {
  canManage,
  ProjectAccessService,
  type ProjectAccessContext,
} from '../projects/project-access.service';
import { Project, type ProjectDocument } from '../projects/schemas/project.schema';
import { TaskActivityService } from '../task-activity/task-activity.service';
import { UsersService } from '../users/users.service';
import type { AssignTaskDto } from './dto/assign-task.dto';
import type { CreateTaskDto } from './dto/create-task.dto';
import type { ListTasksQueryDto } from './dto/list-tasks.dto';
import type { UpdateTaskDto } from './dto/update-task.dto';
import type { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { Task, type TaskDocument } from './schemas/task.schema';

@Injectable()
export class TasksService {
  constructor(
    @InjectModel(Task.name) private readonly taskModel: Model<TaskDocument>,
    @InjectModel(Project.name) private readonly projectModel: Model<ProjectDocument>,
    @InjectModel(Comment.name) private readonly commentModel: Model<CommentDocument>,
    private readonly projectAccessService: ProjectAccessService,
    private readonly usersService: UsersService,
    private readonly taskActivityService: TaskActivityService,
  ) {}

  async findByProject(
    projectId: Types.ObjectId,
    userId: Types.ObjectId,
    query: ListTasksQueryDto,
  ): Promise<Paginated<TaskSummary>> {
    await this.projectAccessService.assertCanView(projectId, userId);

    const filter: FilterQuery<TaskDocument> = { projectId };
    if (query.status) {
      filter.status = query.status;
    }
    if (query.priority) {
      filter.priority = query.priority;
    }

    const [tasks, total] = await Promise.all([
      this.taskModel.find(filter).sort({ number: 1 }).skip(query.skip).limit(query.pageSize).exec(),
      this.taskModel.countDocuments(filter),
    ]);

    return {
      items: await this.toSummaries(tasks),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async create(
    projectId: Types.ObjectId,
    userId: Types.ObjectId,
    dto: CreateTaskDto,
  ): Promise<TaskDetail> {
    const { project } = await this.projectAccessService.assertCanView(projectId, userId);

    const taskCount = await this.taskModel.countDocuments({ projectId });
    const number = taskCount + 1;

    const task = await this.taskModel.create({
      projectId,
      number,
      key: `${project.key}-${number}`,
      title: dto.title,
      description: dto.description ?? null,
      status: dto.status,
      priority: dto.priority,
      createdBy: userId,
    });

    return this.toDetail(task, project);
  }

  async findOne(taskId: Types.ObjectId, userId: Types.ObjectId): Promise<TaskDetail> {
    const task = await this.findTaskOrFail(taskId);
    const { project } = await this.projectAccessService.assertCanView(task.projectId, userId);

    return this.toDetail(task, project);
  }

  async update(
    taskId: Types.ObjectId,
    userId: Types.ObjectId,
    dto: UpdateTaskDto,
  ): Promise<TaskDetail> {
    const task = await this.findTaskOrFail(taskId);
    const access = await this.projectAccessService.assertCanView(task.projectId, userId);

    const isCreator = task.createdBy.equals(userId);
    if (!canManage(access) && !isCreator) {
      throw new ForbiddenException('You do not have permission to edit this task');
    }

    if (dto.title !== undefined) {
      task.title = dto.title;
    }
    if (dto.description !== undefined) {
      task.description = dto.description;
    }
    if (dto.status !== undefined) {
      task.status = dto.status;
    }
    if (dto.priority !== undefined) {
      task.priority = dto.priority;
    }

    await task.save();

    return this.toDetail(task, access.project);
  }

  /**
   * Sets or clears a task's assignee.
   *
   * Rules (Part Six of the brief):
   *  - The assignee, if any, must be an explicit member of the task's
   *    project — elevated org-role access alone does not make someone
   *    assignable.
   *  - OWNER / ADMIN / PROJECT_MANAGER may assign to, or unassign, anyone.
   *  - A regular project member may only assign the task to themselves, or
   *    remove their own existing assignment. Any other change they attempt
   *    is forbidden.
   *  - A call that doesn't actually change the assignee is a no-op and
   *    skips the "who may change this" check entirely.
   */
  async assignTask(
    taskId: Types.ObjectId,
    actingUserId: Types.ObjectId,
    dto: AssignTaskDto,
  ): Promise<TaskDetail> {
    const task = await this.findTaskOrFail(taskId);
    const access = await this.projectAccessService.assertCanView(task.projectId, actingUserId);

    const previousAssigneeId = task.assignee ?? null;
    const nextAssigneeId = dto.assigneeId ? toObjectId(dto.assigneeId, 'assignee id') : null;

    if (idsEqual(previousAssigneeId, nextAssigneeId)) {
      return this.toDetail(task, access.project);
    }

    this.assertCanChangeAssignee(access, actingUserId, previousAssigneeId, nextAssigneeId);

    if (nextAssigneeId) {
      const isMember = await this.projectAccessService.isProjectMember(
        task.projectId,
        nextAssigneeId,
      );
      if (!isMember) {
        throw new BadRequestException('Assignee must be a member of this project');
      }
    }

    task.assignee = nextAssigneeId;
    await task.save();

    // Not wrapped in a transaction: mongodb-memory-server (and this
    // project's dev setup) runs a standalone MongoDB, which doesn't support
    // multi-document transactions, and no other write path in this codebase
    // uses one either (see `remove()` above). If the process crashes between
    // these two writes, the assignment change lands without its log entry —
    // an acceptable gap for an activity trail, not for the data it describes.
    await this.taskActivityService.recordAssigneeChanged(
      task._id,
      actingUserId,
      previousAssigneeId,
      nextAssigneeId,
    );

    return this.toDetail(task, access.project);
  }

  private assertCanChangeAssignee(
    access: ProjectAccessContext,
    actorId: Types.ObjectId,
    previousAssigneeId: Types.ObjectId | null,
    nextAssigneeId: Types.ObjectId | null,
  ): void {
    if (canManage(access)) {
      return;
    }

    const assigningSelf = nextAssigneeId !== null && nextAssigneeId.equals(actorId);
    const removingOwnAssignment =
      nextAssigneeId === null && previousAssigneeId !== null && previousAssigneeId.equals(actorId);

    if (!assigningSelf && !removingOwnAssignment) {
      throw new ForbiddenException(
        'Only a project manager, admin or owner can assign this task to someone else',
      );
    }
  }

  async updateStatus(taskId: Types.ObjectId, dto: UpdateTaskStatusDto): Promise<TaskDetail> {
    const task = await this.findTaskOrFail(taskId);

    task.status = dto.status;
    await task.save();

    return this.toDetail(task);
  }

  async remove(taskId: Types.ObjectId, userId: Types.ObjectId): Promise<void> {
    const task = await this.findTaskOrFail(taskId);
    await this.projectAccessService.assertCanManage(task.projectId, userId);

    await Promise.all([this.commentModel.deleteMany({ taskId: task._id }), task.deleteOne()]);
  }

  async findTaskOrFail(taskId: Types.ObjectId): Promise<TaskDocument> {
    const task = await this.taskModel.findById(taskId).exec();
    if (!task) {
      throw new NotFoundException('Task not found');
    }
    return task;
  }

  private async toSummaries(tasks: TaskDocument[]): Promise<TaskSummary[]> {
    if (tasks.length === 0) {
      return [];
    }

    const userIds = new Map<string, Types.ObjectId>();
    for (const task of tasks) {
      userIds.set(task.createdBy.toString(), task.createdBy);
      if (task.assignee) {
        userIds.set(task.assignee.toString(), task.assignee);
      }
    }

    const [users, commentRows] = await Promise.all([
      this.usersService.findManyByIds([...userIds.values()]),
      this.commentModel
        .aggregate<{
          _id: Types.ObjectId;
          count: number;
        }>([
          { $match: { taskId: { $in: tasks.map((task) => task._id) } } },
          { $group: { _id: '$taskId', count: { $sum: 1 } } },
        ])
        .exec(),
    ]);

    const usersById = new Map(users.map((user) => [user._id.toString(), user]));
    const commentCounts = new Map(commentRows.map((row) => [row._id.toString(), row.count]));

    return tasks.map((task) => ({
      id: task._id.toString(),
      projectId: task.projectId.toString(),
      number: task.number,
      key: task.key,
      title: task.title,
      status: task.status,
      priority: task.priority,
      commentCount: commentCounts.get(task._id.toString()) ?? 0,
      createdBy: toKnownOrDeletedUser(usersById.get(task.createdBy.toString())),
      assignee: task.assignee
        ? toKnownOrDeletedUser(usersById.get(task.assignee.toString()))
        : null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    }));
  }

  private async toDetail(task: TaskDocument, project?: ProjectDocument): Promise<TaskDetail> {
    const [summary] = await this.toSummaries([task]);
    const resolvedProject = project ?? (await this.projectModel.findById(task.projectId).exec());

    if (!resolvedProject) {
      throw new NotFoundException('Project not found');
    }

    return {
      ...summary!,
      description: task.description ?? null,
      project: {
        id: resolvedProject._id.toString(),
        name: resolvedProject.name,
        key: resolvedProject.key,
      },
    };
  }
}

const DELETED_USER = {
  id: '',
  name: 'Unknown user',
  email: '',
  avatarUrl: null,
};

function toKnownOrDeletedUser(user: Parameters<typeof toUserSummary>[0] | undefined) {
  return user ? toUserSummary(user) : DELETED_USER;
}

function idsEqual(a: Types.ObjectId | null, b: Types.ObjectId | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.equals(b);
}
