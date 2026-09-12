'use client';

import { CaretDownIcon, MagnifyingGlassIcon, UserCircleMinusIcon } from '@phosphor-icons/react/dist/ssr';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { ProjectMemberEntry, UserSummary } from '@projectflow/shared';
import { Avatar } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUser } from '@/features/auth/hooks';
import { useCanManageProject, useProjectMembers } from '@/features/projects/hooks';
import { cn } from '@/lib/utils';
import { useAssignTask } from '../hooks';

/** Below this count the list is short enough to scan; above it, search earns its place. */
const SEARCH_THRESHOLD = 6;

interface AssigneeSelectProps {
  taskId: string;
  projectId: string;
  assignee: UserSummary | null;
}

export function AssigneeSelect({ taskId, projectId, assignee }: AssigneeSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const currentUser = useCurrentUser();
  const members = useProjectMembers(projectId);
  const { canManage } = useCanManageProject(projectId);
  const assignTask = useAssignTask(taskId, projectId);

  const filteredMembers = useMemo(() => {
    if (!members.data) {
      return [];
    }
    const query = search.trim().toLowerCase();
    if (!query) {
      return members.data;
    }
    return members.data.filter(
      (member) =>
        member.user.name.toLowerCase().includes(query) ||
        member.user.email.toLowerCase().includes(query),
    );
  }, [members.data, search]);

  if (members.isPending || currentUser.isPending) {
    return <Skeleton className="h-8 w-full" />;
  }

  if (members.isError) {
    return (
      <p className="text-[13px] text-danger" role="alert">
        Couldn&apos;t load project members.
      </p>
    );
  }

  const currentUserId = currentUser.data?.id;
  const canRemoveCurrentAssignee = canManage || assignee?.id === currentUserId;

  function selectMember(member: ProjectMemberEntry | null) {
    const nextId = member ? member.user.id : null;
    setOpen(false);
    setSearch('');

    if (nextId === (assignee?.id ?? null)) {
      return;
    }

    assignTask.mutate(
      { assigneeId: nextId, optimisticAssignee: member ? member.user : null },
      { onError: (error) => toast.error(error.message) },
    );
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setSearch('');
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={assignTask.isPending || members.data.length === 0}
          aria-label={assignee ? `Assigned to ${assignee.name}. Change assignee` : 'Unassigned. Assign this task'}
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md border border-border bg-background px-2.5 text-[13px] text-foreground',
            'hover:bg-surface-strong disabled:cursor-not-allowed disabled:opacity-60',
          )}
        >
          {assignee ? (
            <>
              <Avatar user={assignee} size="sm" />
              <span className="min-w-0 flex-1 truncate text-left">{assignee.name}</span>
            </>
          ) : (
            <span className="flex-1 text-left text-subtle-foreground">
              {members.data.length === 0 ? 'No project members' : 'Unassigned'}
            </span>
          )}
          <CaretDownIcon size={12} weight="bold" className="shrink-0 text-subtle-foreground" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        {members.data.length > SEARCH_THRESHOLD ? (
          <div className="p-1">
            <div className="flex items-center gap-1.5 rounded-sm border border-border px-2 py-1">
              <MagnifyingGlassIcon size={13} className="shrink-0 text-subtle-foreground" />
              <input
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                // Radix's roving-focus / typeahead listens for keydown on
                // the menu content; without this, letters typed here move
                // focus between items instead of filtering the list.
                onKeyDown={(event) => event.stopPropagation()}
                placeholder="Search members..."
                aria-label="Search project members"
                className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-subtle-foreground"
              />
            </div>
          </div>
        ) : null}

        <DropdownMenuItem
          disabled={!canRemoveCurrentAssignee}
          onSelect={() => selectMember(null)}
          className="text-muted-foreground"
        >
          <UserCircleMinusIcon size={16} />
          Unassigned
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        {filteredMembers.length === 0 ? (
          <p className="px-2 py-3 text-center text-[12px] text-subtle-foreground">
            No members match &quot;{search}&quot;
          </p>
        ) : (
          <>
            <DropdownMenuLabel>Project members</DropdownMenuLabel>
            {filteredMembers.map((member) => {
              const isSelf = member.user.id === currentUserId;
              const canSelect = canManage || isSelf;

              return (
                <DropdownMenuItem
                  key={member.id}
                  disabled={!canSelect}
                  onSelect={() => selectMember(member)}
                >
                  <Avatar user={member.user} size="sm" />
                  <span className="min-w-0 flex-1 truncate">
                    {member.user.name}
                    {isSelf ? ' (you)' : ''}
                  </span>
                  {member.user.id === assignee?.id ? (
                    <span className="text-[11px] text-subtle-foreground">Assigned</span>
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
