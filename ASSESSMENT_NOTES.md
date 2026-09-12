# Assessment Notes

## Understanding the Existing System

### How is the application structured, and what are the major modules?

ProjectFlow is a pnpm/Turborepo monorepo with two apps and one shared package:

- **`apps/api`** — a NestJS 11 + Mongoose API, organized as one Nest module per
  domain concept: `auth`, `users`, `organizations`, `organization-members`,
  `projects` (which also owns `project-access.service.ts`, the single
  authorization chokepoint — see below), `project-members`, `tasks`,
  `comments`. Each module follows the same shape: `*.controller.ts` (HTTP
  surface), `*.service.ts` (business logic + persistence), `schemas/*.ts`
  (Mongoose schema), and `dto/*.ts` (class-validator input shapes).
- **`apps/web`** — a Next.js 16 App Router frontend. Routes live under
  `src/app`; each domain has a parallel "feature" folder under
  `src/features/<domain>` containing `api.ts` (thin fetch wrappers),
  `hooks.ts` (TanStack Query hooks), and `components/`. Generic UI primitives
  (Button, Dialog, Select, Avatar, …) live in `src/components/ui`, built on
  Radix primitives with Tailwind.
- **`packages/shared`** — enums (`TaskStatus`, `TaskPriority`, `OrganizationRole`,
  `ProjectRole`), cross-cutting constants (max lengths, pagination defaults),
  and the API response DTOs (`TaskSummary`, `TaskDetail`, `ProjectSummary`,
  …). Both apps import this instead of redeclaring shapes, so the wire
  contract is a single source of truth.

### Where does business logic live?

Almost entirely in the API's `*.service.ts` files — controllers are thin
(parse params, delegate, return). Authorization decisions specifically live
in `ProjectAccessService` (`projects/project-access.service.ts`), which is the
one place that answers "can this user touch this project": it resolves a
user's organization role and project role and exposes `assertCanView` /
`assertCanManage` (plus the pure predicates `canView` / `canManage`) that
every other service is expected to call before doing anything. The frontend
holds essentially no business logic — it renders server state and calls
mutations; even client-side validation (e.g. Zod schemas) is a UX nicety, not
an authority.

### How does the frontend talk to the backend, and how is server state handled?

The web app talks to the API over plain `fetch` via `src/lib/api-client.ts`
(`apiRequest`), which attaches the bearer token from `auth-storage.ts`,
serializes query/body, and normalizes the API's error shape
(`ApiErrorBody`) into thrown `Error`s that components/hooks can catch.

All server data is owned by **TanStack Query**. Each feature exposes
`use<Thing>` / `use<Thing>s` query hooks keyed by `src/lib/query-keys.ts`
(a centralized key factory, which keeps invalidation consistent — e.g.
creating a task invalidates both `projectTasks(projectId)` and `projects`
because task count is denormalized onto the project summary). Mutations
(`useCreateTask`, `useUpdateTaskStatus`, …) invalidate or directly
`setQueryData` the affected keys `onSuccess`. There is currently no optimistic
update anywhere in the codebase (`TaskStatusSelect` just disables itself
while pending and toasts on error) — this is one of the things Part Nine
asks us to introduce deliberately for the assignee selector.

### How are authentication and authorization implemented?

**Authentication**: JWT bearer tokens. `POST /auth/register` and
`POST /auth/login` hash/verify passwords with bcrypt (12 rounds) and issue a
signed JWT (`{ sub, email }`) via `AuthService.buildSession`. `JwtAuthGuard` is
registered globally (`APP_GUARD` in `app.module.ts`), so every route requires
a valid bearer token by default; routes opt out with the `@Public()`
decorator (used for `/auth/login`, `/auth/register`). The guard attaches
`request.user = { id, email }`, which controllers read via the
`@CurrentUser()` param decorator.

**Authorization** is two-tiered and resolved per-request, not cached on the
token:

- **Organization role** (`OWNER` / `ADMIN` / `MEMBER`) — `OWNER`/`ADMIN` are
  "elevated" and implicitly get manage-level access to *every* project in
  the organization (`isElevatedOrganizationRole`).
- **Project role** (`PROJECT_MANAGER` / `MEMBER`) — an explicit
  `ProjectMember` row scoped to one project.

`ProjectAccessService.resolve()` loads both in parallel and
`canView`/`canManage` combine them: view access requires an elevated org role
*or* any project membership; manage access requires an elevated org role *or*
the `PROJECT_MANAGER` project role. This is the pattern every task/comment/
project-member mutation is expected to route through — with one exception
noted below.

### How are the main entities related?

```
User ──< OrganizationMember >── Organization ──< Project ──< ProjectMember >── User
                                                    │
                                                    ├──< Task >── createdBy: User
                                                    │       │
                                                    │       └──< Comment >── authorId: User
                                                    │
                                                    └── (Part Five) Task.assignee: User, nullable
```

- `OrganizationMember` and `ProjectMember` are the two join collections that
  carry roles; both have a unique `(parentId, userId)` index.
- `Project.key` + `Task.number` compose the human-facing `Task.key`
  (e.g. `ENG-101`); `number` is scoped per-project (see the concurrency
  observation below).
- `Task.createdBy` and `Comment.authorId` are plain `ObjectId` references
  resolved via `UsersService.findManyByIds` in batch, not per-row — this is
  the pattern the new activity feed should follow.

---

## Observations — Risks and Weaknesses

**1. `PATCH /tasks/:taskId/status` performs no project-authorization check at all.**
`TasksController.updateStatus` calls `TasksService.updateStatus`, which loads
the task and saves the new status but never calls `ProjectAccessService`.
Every other task-mutating path (`update`, `remove`, `create`) asserts view or
manage access first; this one doesn't. Concretely, any authenticated user —
including someone with no organization or project membership at all — can
change the status of any task in the system if they know (or guess/enumerate)
its id. *Why it's a problem*: it's a real, unauthenticated-within-the-app
authorization bypass, and it matches the exact symptom reported in Part
Eleven ("users can modify tasks belonging to projects they are not members
of"). *Fix now* — this is the production bug investigation, handled with a
regression test in `BUG_REPORT.md`.

**2. Task numbering is a count-then-insert race (`count + 1`).**
`TasksService.create` computes `number` from `countDocuments({ projectId })`
before inserting. Two requests creating tasks in the same project at
overlapping times can both read the same count and both insert with the same
`number`/`key`, silently producing duplicate `ENG-101`s. There's no unique
index on `(projectId, number)` to even catch it at the database level.
*Why it's a problem*: task keys are meant to be stable, human-referenced
identifiers (used in URLs, mentioned in conversation); a collision is a data
integrity issue, not just a cosmetic one. *Fix now* — this is Part Six/Twelve;
addressed with an atomic counter and a backing unique index.

**3. A comment from a deleted user silently vanishes instead of degrading gracefully.**
`CommentsService.toEntries` does `authorsById.get(...)` and `flatMap`s to `[]`
when the author isn't found, which *removes the comment from the response
entirely*. Contrast this with `TasksService.toCreatorSummary`, which falls
back to a `DELETED_USER` placeholder (`"Unknown user"`) so the task itself
stays visible. The two features handle the identical situation
(a referenced user row is gone) inconsistently, and the comments behavior is
the worse one: a discussion thread can appear to have fewer messages than it
did, with no indication anything was removed. *Why it could be a problem*:
mostly integrity-of-history/trust, not a security issue. *Fix later* — worth
aligning with the `DELETED_USER` pattern, but it's pre-existing behavior
outside this assessment's scope; noted here rather than fixed, and I made
sure the new activity feature does *not* repeat this mistake (see Part
Seven/Eight).

**4. No rate limiting or lockout on `/auth/login` (or `/auth/register`).**
Both are `@Public()` and otherwise unguarded — nothing in `main.ts` or
`AuthModule` throttles repeated attempts. Combined with a 7-day default JWT
expiry and no refresh/rotation or revocation list, a leaked or brute-forced
token is usable for a long window with no server-side way to invalidate it
early (short of rotating `JWT_SECRET`, which invalidates every session).
*Why it's a problem*: standard credential-stuffing / brute-force exposure.
*Fix later* — out of scope for this assessment (no new auth surface was
requested), but worth flagging: e.g. `@nestjs/throttler` on the auth routes,
and a shorter-lived access token plus a refresh token if the product
eventually needs revocation.

**5. `ProjectAccessService.resolve()` issues two DB round-trips per authorization check, on every task/comment mutation.**
Every call to `assertCanView`/`assertCanManage` re-fetches the project, the
caller's organization-member row, and the caller's project-member row — none
of it cached within the request, let alone across requests. For a single
task fetch this is fine; for something like the new activity list (Part
Eight, "no obvious N+1") it's a reminder to resolve access *once* per request
and reuse the result rather than re-deriving it per row. *Fix later* — the
current per-request cost is small at this data size; I kept the existing
pattern (one `assertCanView`/`assertCanManage` call per request) for the
features I added rather than introducing request-scoped caching, since that
would be a cross-cutting change beyond this assessment's scope.

