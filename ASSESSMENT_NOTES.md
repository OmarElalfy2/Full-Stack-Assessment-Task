# Assessment Notes

## Understanding the Existing System

ProjectFlow is a pnpm/Turborepo monorepo with:

- `apps/api` — NestJS + Mongoose + MongoDB backend.
- `apps/web` — Next.js frontend using TanStack Query.
- `packages/shared` — shared TypeScript types, enums, and constants used by both frontend and backend.

The backend is organized by domain. Controllers handle HTTP requests, services contain business logic and database access, DTOs validate incoming data, and schemas define MongoDB documents.

Most authorization is handled through `ProjectAccessService`. It checks both organization roles and project roles:

- `OWNER` / `ADMIN` have elevated access across projects in their organization.
- `PROJECT_MANAGER` can manage a project.
- Regular project members can view the projects they belong to.

Authentication is separate from that: it uses JWT bearer tokens, with passwords hashed using bcrypt. A global `JwtAuthGuard` requires a valid token on every route by default; the few routes that don't need one (register, login) opt out explicitly with a `@Public()` decorator.

The frontend communicates with the backend through a shared API client using bearer-token authentication. TanStack Query handles server state, caching, mutations, and invalidation.

The main entities are:

- User
- Organization
- OrganizationMember
- Project
- ProjectMember
- Task
- Comment
- TaskActivity

`OrganizationMember` and `ProjectMember` aren't just names in that list — they're join records linking a `User` to an `Organization` or `Project` and carrying that user's role there. An `Organization` owns many `Project`s, a `Project` owns many `Task`s, and a `Task` owns many `Comment`s and many `TaskActivity` records.

A task belongs to one project, has a creator, and may have an assignee.

---

## Observations and Risks

### 1. Missing authorization on task status updates

`PATCH /tasks/:taskId/status` originally updated the task without checking whether the current user belonged to the task's project.

This meant an authenticated outsider could change another project's task status if they knew the task ID.

**Decision:** Fix now because it is a real security issue and matches the reported production bug.

### 2. Task-number generation was not concurrency-safe

Task numbers were generated using:

```ts
const count = await Task.countDocuments({ projectId });
const nextNumber = count + 1;
```

Two concurrent requests could read the same count and create duplicate task numbers.

**Decision:** Fix now using an atomic per-project counter and a unique database index.

### 3. Deleted comment authors are handled inconsistently

If a comment's author no longer exists, the current comment serialization may remove the comment from the response. Other parts of the system use an `"Unknown user"` placeholder instead.

**Decision:** Leave for later because it is outside the required scope.

### 4. Authentication has no rate limiting

The public login/register endpoints do not currently have throttling or lockout protection.

**Decision:** Leave for later because the assessment does not ask for authentication redesign.

### 5. Authorization causes several database lookups per request

`ProjectAccessService` loads the project, organization role, and project role whenever access is checked.

This is acceptable at the current scale, but could be optimized later if it becomes a bottleneck.

---

## Task Assignment Design

I added task assignment as a dedicated endpoint:

```http
PATCH /tasks/:taskId/assignee
```

I kept it separate from the normal task update endpoint because assignment has its own business rules and activity-history side effect.

The main rules are:

- Only explicit project members can be assigned.
- `OWNER`, `ADMIN`, and `PROJECT_MANAGER` can assign other members.
- A regular member can assign a task to themselves.
- A regular member can remove their own assignment.
- Authorized users can unassign tasks.
- Reassigning to the same user is treated as a no-op.

The task schema stores a nullable `assignee` user reference.

---

## Activity History

Assignee changes are stored in a separate `task_activities` collection.

Each record contains:

- task
- actor
- activity type
- previous assignee
- new assignee
- creation time

This supports all required transitions:

- unassigned → assigned
- assigned → another user
- assigned → unassigned

The activity endpoint is:

```http
GET /tasks/:taskId/activity
```

It is paginated, newest-first, authorization-protected, and uses batched user lookups to avoid N+1 queries.

---

## Frontend

The task detail page includes an assignee selector and activity timeline.

The assignee selector:

- shows project members
- supports search when the member list is larger
- disables options the current user is not allowed to select
- supports assignment and unassignment
- uses optimistic updates with rollback if the request fails

The backend still performs the real authorization checks. The frontend permission checks are only for better user experience.

The activity timeline converts raw records into readable messages such as:

- `Ammar assigned Magd`
- `Magd changed the assignee from themselves to Ahmed`
- `Ahmed removed the assignee`

---

## Production Bug

The reported bug was confirmed.

### Root cause

The task-status endpoint did not pass the current user ID into the service and did not perform a project-access check.

### Fix

The endpoint now passes the authenticated user ID and calls `ProjectAccessService.assertCanView()` before updating the task.

### Regression prevention

Automated tests verify that:

- a project member can update task status
- a user outside the project receives `403`

---

## Concurrent Task Creation

The original `count + 1` approach had a race condition.

I replaced it with a separate per-project counter that uses MongoDB's atomic `$inc`.

A unique index on:

```ts
{ projectId: 1, number: 1 }
```

acts as a database-level safety check.

While testing, I found another edge case when the counter document did not exist yet. To avoid that race, a counter row is created when the project itself is created. Seed data and test fixtures were also updated so their counters stay synchronized with existing tasks.

---

## Testing

The automated tests focus on the important business rules rather than coverage percentage.

They include:

- regular member can assign themselves
- manager can assign another project member
- regular member cannot assign another member
- outsider cannot be assigned
- regular member cannot remove someone else's assignment
- assignment creates activity
- unassignment creates activity
- outsider cannot access task activity
- outsider cannot update another project's task status
- concurrent task creation does not create duplicate task numbers

---

## Code Review

The provided `assignTask()` implementation should not be merged as-is.

Main problems:

1. No project authorization check.
2. `userId` is passed in but never used.
3. It checks whether the assignee exists, but not whether they belong to the project.
4. It does not enforce the self-vs-others assignment rule.
5. It cannot represent unassignment.
6. It does not create an activity record.
7. It does not handle no-op assignments.
8. It does not validate IDs using the project's existing helpers.
9. It returns a raw Mongoose document instead of the normal serialized `TaskDetail`.

I would ask the author to fix correctness and security first. Small performance improvements would come after that.

---

## Scaling the Activity System

At the current size, MongoDB with the existing activity collection is enough.

If activity becomes one of the largest datasets in the system, I would improve it gradually:

- Keep indexes aligned with real query patterns, especially `{ taskId, createdAt: -1 }`.
- Move from offset pagination to cursor pagination for large histories.
- Keep actor/from/to resolution batched instead of querying one user per row.
- Add retention or archiving only when old activity becomes expensive to keep in the main collection.
- Move non-critical side effects to background jobs only if activity writes begin slowing down normal requests.
- Add caching only for data that is read often enough to justify it.
- Add metrics and tracing around slow queries, activity volume, and error rates before introducing more infrastructure.

I would not introduce Redis, queues, or other infrastructure until there is a measured problem that requires them.

---

## If I Had Two More Days

In priority order, I would:

1. Improve consistency for deleted users, especially comments that currently disappear when their author no longer exists.
2. Add rate limiting and better authentication protection to the public auth endpoints.
3. Add more edge-case and frontend tests for assignment and activity behavior.
4. Improve observability around authorization failures, activity queries, and concurrent task creation.
5. Review query performance with larger datasets and add indexes only where measurements show they are needed.
