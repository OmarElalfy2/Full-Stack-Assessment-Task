'use client';

import { useQuery } from '@tanstack/react-query';
import {
  isElevatedOrganizationRole,
  ProjectRole,
  type ProjectDetail,
  type ProjectMemberEntry,
  type ProjectSummary,
} from '@projectflow/shared';
import { useCurrentUser } from '@/features/auth/hooks';
import { queryKeys } from '@/lib/query-keys';
import { fetchProject, fetchProjectMembers, fetchProjects } from './api';

export function useProjects() {
  return useQuery<ProjectSummary[]>({
    queryKey: queryKeys.projects,
    queryFn: fetchProjects,
  });
}

export function useProject(projectId: string) {
  return useQuery<ProjectDetail>({
    queryKey: queryKeys.project(projectId),
    queryFn: () => fetchProject(projectId),
    enabled: projectId.length > 0,
  });
}

export function useProjectMembers(projectId: string) {
  return useQuery<ProjectMemberEntry[]>({
    queryKey: queryKeys.projectMembers(projectId),
    queryFn: () => fetchProjectMembers(projectId),
    enabled: projectId.length > 0,
  });
}

/**
 * Mirrors the API's `canManage` rule (elevated org role, or `PROJECT_MANAGER`
 * on this project) purely for UI decisions — which options an assignee
 * picker enables, for example. This is not a security boundary; the backend
 * enforces the actual rule independently and rejects anything this check
 * gets wrong.
 */
export function useCanManageProject(projectId: string) {
  const currentUser = useCurrentUser();
  const project = useProject(projectId);
  const members = useProjectMembers(projectId);

  const isLoading = currentUser.isPending || project.isPending || members.isPending;

  if (isLoading || !currentUser.data || !project.data || !members.data) {
    return { canManage: false, isLoading };
  }

  const organizationRole = currentUser.data.organizations.find(
    (organization) => organization.id === project.data.organization.id,
  )?.role;
  const projectRole = members.data.find(
    (member) => member.user.id === currentUser.data!.id,
  )?.role;

  const canManage =
    isElevatedOrganizationRole(organizationRole) || projectRole === ProjectRole.PROJECT_MANAGER;

  return { canManage, isLoading: false };
}
