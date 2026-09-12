import type { UserSummary } from '@projectflow/shared';
import type { Types } from 'mongoose';

export type IdLike = Types.ObjectId | string;

export function idToString(value: IdLike): string {
  return typeof value === 'string' ? value : value.toString();
}

interface UserLike {
  _id: IdLike;
  name: string;
  email: string;
  avatarUrl?: string | null;
}

/** Projects a user document down to the fields the API is allowed to expose. */
export function toUserSummary(user: UserLike): UserSummary {
  return {
    id: idToString(user._id),
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl ?? null,
  };
}

/** Placeholder shown in place of a referenced user whose account no longer exists. */
export const DELETED_USER: UserSummary = {
  id: '',
  name: 'Unknown user',
  email: '',
  avatarUrl: null,
};

/**
 * Projects a possibly-missing user to a summary, falling back to
 * `DELETED_USER` rather than dropping whatever record referenced them.
 * Shared by every feature that resolves a batch of user ids (task
 * creators/assignees, activity actors) so a deleted account degrades the
 * same way everywhere instead of each call site inventing its own handling.
 */
export function toUserSummaryOrDeleted(user: UserLike | undefined): UserSummary {
  return user ? toUserSummary(user) : DELETED_USER;
}
