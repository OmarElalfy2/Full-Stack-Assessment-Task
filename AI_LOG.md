# AI Usage Log

## 1. Tools Used

- ChatGPT
- Claude

## 2. How I Used AI

I used AI mainly as a support tool during the assessment.

It helped me with:
- Understanding parts of the existing codebase and architecture.
- Discussing implementation ideas before I wrote or changed code.
- Debugging some issues during development and deployment.
- Reviewing some test cases and edge cases.
- Explaining concepts such as authorization, activity history, and concurrent task creation.

I still worked through the codebase myself, made the final implementation decisions, tested the application, and reviewed the changes before keeping them.

## 3. Suggestions I Rejected or Changed

I did not use every AI suggestion directly.

For example, I chose to keep task assignment as a separate endpoint instead of mixing it into the normal task update endpoint because assignment has its own permissions, validation, unassignment behavior, and activity logging.

I also changed parts of the concurrency solution after testing showed an additional edge case around creating the task counter for a new project.

## 4. Generated Code I Modified

AI sometimes provided small code examples or implementation patterns, but I adapted them to the existing project structure before using them.

Examples include:
- Task assignee handling.
- Activity history logic.
- Batched user lookups.
- Some test ideas.
- Deployment configuration for Render and Vercel.

I reviewed and tested the final code myself and made changes where needed so it matched the existing architecture and assessment requirements.
