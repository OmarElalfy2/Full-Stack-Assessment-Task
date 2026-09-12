# ProjectFlow

ProjectFlow is a lightweight project and task tracker for software teams.
Organizations own projects, projects own tasks, and tasks carry a status, a
priority and a discussion thread.

It is a TypeScript monorepo: a NestJS + MongoDB API and a Next.js App Router
frontend, sharing a small package of domain types and enums.

---

## Technology stack

| Area         | Choice                                           |
| ------------ | ------------------------------------------------ |
| Monorepo     | pnpm workspaces + Turborepo                      |
| Language     | TypeScript 5.9                                   |
| API          | NestJS 11, Mongoose 8, MongoDB                   |
| Auth         | JWT bearer tokens, bcrypt password hashing       |
| Web          | Next.js 16 (App Router), React 19                |
| Styling      | Tailwind CSS 4, Radix primitives, Phosphor Icons |
| Server state | TanStack Query 5                                 |
| Forms        | React Hook Form + Zod                            |
| Testing      | Jest, Supertest, mongodb-memory-server           |

---

## Prerequisites

- **Node.js 20.19+** (22 or 24 recommended)
- **pnpm 10+** — `npm install -g pnpm`
- **MongoDB 7+** running locally

On macOS:

```bash
brew tap mongodb/brew
brew install mongodb-community@7.0
brew services start mongodb-community@7.0
```

Any reachable MongoDB works — point `MONGODB_URI` wherever you like.

---

## Installation

```bash
pnpm install
```

## Environment setup

Configuration lives in a single `.env` file at the repository root; both apps
read it.

```bash
cp .env.example .env
```

| Variable              | Purpose                          | Default                                 |
| --------------------- | -------------------------------- | --------------------------------------- |
| `MONGODB_URI`         | MongoDB connection string        | `mongodb://127.0.0.1:27017/projectflow` |
| `JWT_SECRET`          | Signing secret for access tokens | — (required)                            |
| `JWT_EXPIRES_IN`      | Access token lifetime            | `7d`                                    |
| `API_PORT`            | Port the API listens on          | `4732`                                  |
| `WEB_ORIGIN`          | Origin allowed by CORS           | `http://localhost:3742`                 |
| `NEXT_PUBLIC_API_URL` | API base URL used by the browser | `http://localhost:4732`                 |

The API refuses to boot if `MONGODB_URI` or `JWT_SECRET` is missing.

## Database

Make sure MongoDB is running, then load development data:

```bash
pnpm seed
```

The seed is repeatable — it clears the ProjectFlow collections and reinserts a
fresh organization, users, projects, tasks and comments.

## Running the apps

```bash
pnpm dev
```

- Web — <http://localhost:3742>
- API — <http://localhost:4732>

Both apps deliberately avoid the usual 3000/4000 defaults so they do not clash
with other projects. To move the web app, set `WEB_PORT` in your shell and
update `WEB_ORIGIN` in `.env` to match, so CORS keeps working:

```bash
WEB_PORT=3800 pnpm --filter @projectflow/web dev
```

The API port comes from `API_PORT` in `.env`; change `NEXT_PUBLIC_API_URL` to
match if you move it.

Run one at a time if you prefer:

```bash
pnpm --filter @projectflow/api dev
pnpm --filter @projectflow/web dev
```

## From a clean checkout

```bash
pnpm install
cp .env.example .env
pnpm seed
pnpm dev
```

---

## Commands

| Command          | Description                                |
| ---------------- | ------------------------------------------ |
| `pnpm dev`       | Run the API and web app in watch mode      |
| `pnpm build`     | Build every package and app                |
| `pnpm lint`      | ESLint across the workspace                |
| `pnpm typecheck` | TypeScript project-wide, no emit           |
| `pnpm test`      | API test suite (uses an in-memory MongoDB) |
| `pnpm seed`      | Reset and reload development data          |
| `pnpm format`    | Prettier write                             |

`pnpm test` does not need a running MongoDB — it starts a throwaway in-memory
server for the duration of the run. The first run downloads a MongoDB binary
(around 100 MB) and caches it.

---

## Development credentials

Seeded accounts, all sharing the password `Password123!`:

| Name         | Email                 | Access                    |
| ------------ | --------------------- | ------------------------- |
| Ammar Yaser  | `ammar@example.com`   | Organization owner        |
| Sarah Ahmed  | `sarah@example.com`   | Organization admin        |
| Ahmed Hassan | `ahmed@example.com`   | Project manager on `ENG`  |
| Magd Ali     | `magd@example.com`    | Member of `ENG` and `WEB` |
| Outside User | `outside@example.com` | No organization           |

These are local development accounts only.

---

## Architecture

```
projectflow/
├── apps/
│   ├── api/                     NestJS API
│   │   ├── src/
│   │   │   ├── auth/            register / login / current user
│   │   │   ├── users/
│   │   │   ├── organizations/
│   │   │   ├── organization-members/
│   │   │   ├── projects/        projects + ProjectAccessService
│   │   │   ├── project-members/
│   │   │   ├── tasks/
│   │   │   ├── comments/
│   │   │   ├── common/          guards, decorators, filters, shared DTOs
│   │   │   └── database/seed.ts
│   │   └── test/                e2e suites and fixtures
│   │
│   └── web/                     Next.js App Router frontend
│       └── src/
│           ├── app/             routes and layouts
│           ├── components/      design system primitives + app shell
│           ├── features/        auth, projects, tasks, comments
│           ├── lib/             API client, query keys, formatting
│           └── providers/       TanStack Query provider
│
└── packages/
    ├── shared/                  enums, constants, API response types
    ├── eslint-config/           flat ESLint configs
    └── tsconfig/                base TypeScript configs
```

### API layering

Each module follows the same shape: controller → service → Mongoose model, with
DTOs validating input at the boundary. Controllers stay thin; business rules
live in services.

### Domain model

```
User
Organization        ── OrganizationMember ── User      (OWNER | ADMIN | MEMBER)
Organization  ── Project
Project             ── ProjectMember      ── User      (PROJECT_MANAGER | MEMBER)
Project       ── Task ── Comment
                     ── TaskActivity                    (append-only; assignee-change history)
              ── TaskCounter                            (one row per project; not user-facing)

Task.createdBy: User (who made it)
Task.assignee:  User | null (who owns it — a separate field, not conflated with createdBy)
```

Membership is stored in its own collection rather than as arrays on the parent
document, so it can be indexed and queried directly. Both membership
collections carry a unique compound index on their two foreign keys.

Tasks are numbered per project and identified by a human-readable key derived
from the project key: `ENG-1`, `ENG-2`, `WEB-1`. Numbers come from `TaskCounter`
(one document per project, `_id` = the project's id), incremented atomically
via `findOneAndUpdate` + `$inc`, seeded synchronously when the project itself
is created. A unique `{projectId, number}` index on `Task` is the database-level
backstop. See "Technical Decisions" below for why it's a separate collection
rather than a field on `Project`.

`TaskActivity` is an append-only log — one row per assignee change, with
`actorId` and a `{from, to}` pair of (possibly null) user ids, resolved to
full user summaries in the API response. Nothing in this codebase ever
updates or deletes a row.

### Authorization

`ProjectAccessService` answers "may this user touch this project?" in one
place. Access comes from either an elevated organization role (`OWNER` or
`ADMIN`, which grants access to every project in the organization) or an
explicit project membership row. `assertCanView` gates reads, `assertCanManage`
gates configuration and membership changes.

Authentication is a JWT bearer token. `JwtAuthGuard` is registered globally;
routes opt out with the `@Public()` decorator.

**Task assignment** has its own narrower rule, checked separately from
`canView`/`canManage`: the assignee must hold an explicit `ProjectMember` row
(an elevated org role alone doesn't make someone assignable). Any project
member may assign a task to themselves or clear their own assignment;
changing *someone else's* assignment requires `canManage`.

### API surface

```
POST   /auth/register
POST   /auth/login
GET    /auth/me

GET    /organizations

GET    /projects
POST   /projects
GET    /projects/:projectId
GET    /projects/:projectId/members
POST   /projects/:projectId/members

GET    /projects/:projectId/tasks
POST   /projects/:projectId/tasks
GET    /tasks/:taskId
PATCH  /tasks/:taskId
PATCH  /tasks/:taskId/status
PATCH  /tasks/:taskId/assignee
DELETE /tasks/:taskId

GET    /tasks/:taskId/activity
GET    /tasks/:taskId/comments
POST   /tasks/:taskId/comments
```

Errors share one shape:

```json
{
  "statusCode": 403,
  "message": "You do not have access to this project",
  "error": "Forbidden"
}
```

### Frontend

Routes are thin; the work happens in `features/`. Server state is owned by
TanStack Query — query keys live in `lib/query-keys.ts` so invalidation stays
predictable — and local UI state stays in React. The API client in
`lib/api-client.ts` centralises the base URL, the auth header and error
parsing.

Components are server components by default; `"use client"` is added only where
interactivity or hooks require it.

---

## Technical Decisions

The major decisions behind the task-assignment and activity feature, and the
two production fixes:

- **Task numbering uses a dedicated `TaskCounter` collection, not a field on
  `Project`.** Incremented atomically via `findOneAndUpdate` + `$inc`, and
  seeded synchronously in `ProjectsService.create()` rather than lazily on a
  project's first task. `findOneAndUpdate` with `upsert: true` is only fully
  atomic once the target document exists — two concurrent upserts racing to
  *create* a counter can both compute the same first value on a standalone
  MongoDB (no replica set, so no retryable-writes safety net to catch it).
  Creating the row at project-creation time — a moment with no concurrent
  writer, since a project can only be created once — removes that race for
  every new project. `upsert: true` remains as a defensive fallback for data
  predating this design. A unique `{projectId, number}` index is the
  database-level backstop either way.
- **Activity is a separate append-only collection, not fields on `Task`.**
  So history can grow and page independently of the task it describes.
  Actor/from/to users are resolved to full summaries in one batched query per
  page, not one query per row.
- **No transaction between the task write and the activity write.** Two
  sequential writes, matching every other multi-write path already in this
  codebase (`TasksService.remove()`'s `Promise.all` of two deletes). The
  local/test MongoDB is standalone — transactions aren't available without
  moving to a replica set first, which felt like a bigger change to make
  silently than documenting the gap.
- **`PATCH /tasks/:taskId/status`'s authorization fix uses `assertCanView`,
  not the stricter `assertCanManage`.** Matches the existing permission level
  of `create`/`findOne` (any project member), since moving a task through its
  workflow is routine for any member and the frontend never gated it by
  role. Fixing the reported bug (outsiders) without also newly restricting
  legitimate members was the goal.
- **No new dependencies.** The assignee selector's search is a plain
  filtered `<input>` inside the existing `DropdownMenu` primitive, not a new
  combobox library; the activity timeline's relative timestamps use
  `Intl.RelativeTimeFormat`, not a date library.

## Known Limitations

- **Assignment and activity writes aren't transactional** (see above). A
  crash between the two leaves the assignment change without its log entry.
  Needs a replica-set MongoDB plus a session transaction before this is
  production-ready.
- **No rate limiting or account lockout on `/auth/login` or `/auth/register`**,
  and JWTs are long-lived (7 days by default) with no revocation mechanism.
  Pre-existing, not touched by this work.
- **A comment from a deleted user disappears entirely** rather than showing
  a placeholder, inconsistent with how tasks handle the same situation for
  `createdBy`/`assignee`. Pre-existing; the assignment/activity features
  added here use the consistent placeholder, but the comments code path
  wasn't retrofitted.
- **Activity pagination is offset-based** (`page`/`pageSize`), matching every
  other list endpoint in this API. Fine at current data volumes; would need
  to move to cursor-based pagination well before activity history reaches
  meaningful scale (see `ASSESSMENT_NOTES.md`'s Scaling section).
- **The project-member picker in the assignee selector loads the full member
  list client-side** and filters in the browser past a small threshold.
  Fine for typical project sizes; would need a server-side search endpoint
  for very large projects.

