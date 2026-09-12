# Production Bug Report

## Summary and impact

The report is valid. Any authenticated user who knew or obtained a task ObjectId could call `PATCH /tasks/:taskId/status` and change that task's status even when they belonged to neither its project nor its organization. Other task paths checked project access, which made the issue appear intermittent depending on which edit control was used.

## Root cause

`TasksController.updateStatus` did not read `@CurrentUser`, and `TasksService.updateStatus` loaded and saved the task without calling `ProjectAccessService`. Authentication was present globally, but authentication alone was incorrectly treated as sufficient authorization on this one mutation path.

## Reproduction

1. Create a project task as a project member.
2. Authenticate as the seeded `outside@example.com` user, who has no organization or project membership.
3. Send `PATCH /tasks/<taskId>/status` with `{ "status": "DONE" }`.
4. Before the fix the request succeeded and persisted `DONE`. The equivalent project/task reads correctly returned 403, confirming an endpoint-specific authorization gap.

## Fix

The controller now passes the authenticated user ID into `updateStatus`. The service loads the task and calls `ProjectAccessService.assertCanView(task.projectId, userId)` before mutating it. This follows the same centralized project-access rule used by task reads, creation, and comments.

## Regression prevention

The API integration suite includes a test that creates a task as a member, attempts a status update using an outsider's valid JWT, and requires HTTP 403. Assignment and activity endpoints independently enforce the same project access service and have outsider coverage. A future authorization guard/decorator at the project-resource boundary would make omissions harder, but the current service-level check is consistent with this codebase.