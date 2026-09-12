'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Paginated,
  TaskActivityEntry,
  TaskDetail,
  TaskStatus,
  TaskSummary,
  UserSummary,
} from '@projectflow/shared';
import { queryKeys } from '@/lib/query-keys';
import {
  assignTask,
  createTask,
  type CreateTaskPayload,
  fetchProjectTasks,
  fetchTask,
  fetchTaskActivity,
  updateTaskStatus,
} from './api';

export function useProjectTasks(projectId: string) {
  return useQuery<Paginated<TaskSummary>>({
    queryKey: queryKeys.projectTasks(projectId),
    queryFn: () => fetchProjectTasks(projectId),
    enabled: projectId.length > 0,
  });
}

export function useTask(taskId: string) {
  return useQuery<TaskDetail>({
    queryKey: queryKeys.task(taskId),
    queryFn: () => fetchTask(taskId),
    enabled: taskId.length > 0,
  });
}

export function useCreateTask(projectId: string) {
  const queryClient = useQueryClient();

  return useMutation<TaskDetail, Error, CreateTaskPayload>({
    mutationFn: (payload) => createTask(projectId, payload),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(projectId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
      ]);
    },
  });
}

export function useUpdateTaskStatus(taskId: string, projectId: string) {
  const queryClient = useQueryClient();

  return useMutation<TaskDetail, Error, TaskStatus>({
    mutationFn: (status) => updateTaskStatus(taskId, status),
    onSuccess: async (task) => {
      queryClient.setQueryData(queryKeys.task(taskId), task);
      await queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(projectId) });
    },
  });
}

export interface AssignTaskVariables {
  /** Sent to the API as-is. `null` unassigns. */
  assigneeId: string | null;
  /**
   * The full member the id resolves to (or `null`), supplied by the caller
   * so the optimistic update below can render an avatar and name
   * immediately instead of just an id.
   */
  optimisticAssignee: UserSummary | null;
}

interface AssignTaskContext {
  previousTask: TaskDetail | undefined;
}

/**
 * The one optimistic mutation in this codebase (every other mutation here
 * just invalidates and waits). Assignment is worth it: it's a single-field,
 * easily-reversible change on a page the user is already looking at, so an
 * instant flip-back-on-error reads as "that didn't work" rather than a
 * jarring UI snap once a background invalidation lands.
 */
export function useAssignTask(taskId: string, projectId: string) {
  const queryClient = useQueryClient();

  return useMutation<TaskDetail, Error, AssignTaskVariables, AssignTaskContext>({
    mutationFn: ({ assigneeId }) => assignTask(taskId, assigneeId),
    onMutate: async ({ optimisticAssignee }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.task(taskId) });

      const previousTask = queryClient.getQueryData<TaskDetail>(queryKeys.task(taskId));
      if (previousTask) {
        queryClient.setQueryData<TaskDetail>(queryKeys.task(taskId), {
          ...previousTask,
          assignee: optimisticAssignee,
        });
      }

      return { previousTask };
    },
    onError: (_error, _variables, context) => {
      if (context?.previousTask) {
        queryClient.setQueryData(queryKeys.task(taskId), context.previousTask);
      }
    },
    onSuccess: (task) => {
      // Replace the optimistic guess with what the server actually saved
      // (e.g. the resolved `DELETED_USER` fallback, if that ever applies).
      queryClient.setQueryData(queryKeys.task(taskId), task);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectTasks(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.taskActivity(taskId) });
    },
  });
}

export function useTaskActivity(taskId: string) {
  return useQuery<Paginated<TaskActivityEntry>>({
    queryKey: queryKeys.taskActivity(taskId),
    queryFn: () => fetchTaskActivity(taskId),
    enabled: taskId.length > 0,
  });
}
