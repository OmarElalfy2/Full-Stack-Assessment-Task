import type { INestApplication } from '@nestjs/common';
import type { Connection } from 'mongoose';
import request from 'supertest';
import {
  OrganizationRole,
  ProjectRole,
  TaskActivityType,
  type TaskActivityEntry,
} from '@projectflow/shared';
import { createTestApp, resetDatabase } from './utils/test-app';
import {
  addOrganizationMember,
  addProjectMember,
  authHeader,
  createOrganization,
  createProject,
  createTask,
  registerUser,
  type TestUser,
} from './utils/fixtures';

describe('Task assignment', () => {
  let app: INestApplication;
  let connection: Connection;

  // `owner` acts purely as the task creator here; assignment authorization
  // is exercised through `manager` (an explicit PROJECT_MANAGER) so the
  // project-role path is tested independently of the elevated-org-role path
  // that Part One's notes describe as an alternate route to `canManage`.
  let owner: TestUser;
  let manager: TestUser;
  let memberA: TestUser;
  let memberB: TestUser;
  let outsider: TestUser;
  let projectId: string;
  let taskId: string;

  beforeAll(async () => {
    ({ app, connection } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(connection);

    owner = await registerUser(app, 'Ammar Yaser', 'ammar@example.com');
    manager = await registerUser(app, 'Sarah Ahmed', 'sarah@example.com');
    memberA = await registerUser(app, 'Magd Ali', 'magd@example.com');
    memberB = await registerUser(app, 'Ahmed Hassan', 'ahmed@example.com');
    outsider = await registerUser(app, 'Outside User', 'outside@example.com');

    const organizationId = await createOrganization(
      connection,
      'Acme Software',
      'acme-software',
      owner.id,
    );
    await addOrganizationMember(connection, organizationId, owner.id, OrganizationRole.OWNER);
    await addOrganizationMember(connection, organizationId, manager.id, OrganizationRole.MEMBER);
    await addOrganizationMember(connection, organizationId, memberA.id, OrganizationRole.MEMBER);
    await addOrganizationMember(connection, organizationId, memberB.id, OrganizationRole.MEMBER);
    // `outsider` deliberately joins neither the organization nor the project.

    projectId = await createProject(
      connection,
      organizationId,
      'Internal Platform',
      'ENG',
      owner.id,
    );
    await addProjectMember(connection, projectId, manager.id, ProjectRole.PROJECT_MANAGER);
    await addProjectMember(connection, projectId, memberA.id, ProjectRole.MEMBER);
    await addProjectMember(connection, projectId, memberB.id, ProjectRole.MEMBER);

    taskId = await createTask(connection, projectId, 'ENG', 1, 'Ship the release', owner.id);
  });

  describe('PATCH /tasks/:taskId/assignee', () => {
    it('lets a project member assign the task to themselves', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/assignee`)
        .set('Authorization', authHeader(memberA))
        .send({ assigneeId: memberA.id })
        .expect(200);

      expect(response.body.assignee).toMatchObject({ id: memberA.id });
    });

    it('lets an authorized project role assign a different project member', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/assignee`)
        .set('Authorization', authHeader(manager))
        .send({ assigneeId: memberA.id })
        .expect(200);

      expect(response.body.assignee).toMatchObject({ id: memberA.id });
    });

    it('refuses to let a regular member assign someone else', async () => {
      await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/assignee`)
        .set('Authorization', authHeader(memberA))
        .send({ assigneeId: memberB.id })
        .expect(403);
    });

    it('refuses to let a regular member remove another member\'s assignment', async () => {
      await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/assignee`)
        .set('Authorization', authHeader(manager))
        .send({ assigneeId: memberA.id })
        .expect(200);

      // memberB never held the assignment and isn't a manager, so they may
      // neither assign it to someone else nor clear it.
      await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/assignee`)
        .set('Authorization', authHeader(memberB))
        .send({ assigneeId: null })
        .expect(403);
    });

    it('refuses to assign a task to someone outside the project', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/assignee`)
        .set('Authorization', authHeader(manager))
        .send({ assigneeId: outsider.id })
        .expect(400);

      expect(response.body.statusCode).toBe(400);
    });

    it('treats reassigning to the current assignee as a no-op', async () => {
      await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/assignee`)
        .set('Authorization', authHeader(manager))
        .send({ assigneeId: memberA.id })
        .expect(200);

      // Same assignee again — should succeed without creating a second
      // activity entry, since nothing actually changed.
      await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/assignee`)
        .set('Authorization', authHeader(manager))
        .send({ assigneeId: memberA.id })
        .expect(200);

      const activity = await request(app.getHttpServer())
        .get(`/tasks/${taskId}/activity`)
        .set('Authorization', authHeader(manager))
        .expect(200);

      expect(activity.body.total).toBe(1);
    });
  });

  describe('GET /tasks/:taskId/activity', () => {
    it('refuses activity access to someone outside the project', async () => {
      await request(app.getHttpServer())
        .get(`/tasks/${taskId}/activity`)
        .set('Authorization', authHeader(outsider))
        .expect(403);
    });

    it('records an activity entry when the assignee changes', async () => {
      await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/assignee`)
        .set('Authorization', authHeader(manager))
        .send({ assigneeId: memberA.id })
        .expect(200);

      const response = await request(app.getHttpServer())
        .get(`/tasks/${taskId}/activity`)
        .set('Authorization', authHeader(manager))
        .expect(200);

      expect(response.body.total).toBe(1);
      const [entry] = response.body.items as TaskActivityEntry[];
      expect(entry).toMatchObject({
        type: TaskActivityType.TASK_ASSIGNEE_CHANGED,
        actor: { id: manager.id },
        metadata: { from: null, to: { id: memberA.id } },
      });
    });

    it('records an activity entry when a task is unassigned', async () => {
      await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/assignee`)
        .set('Authorization', authHeader(manager))
        .send({ assigneeId: memberA.id })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/assignee`)
        .set('Authorization', authHeader(memberA))
        .send({ assigneeId: null })
        .expect(200);

      const response = await request(app.getHttpServer())
        .get(`/tasks/${taskId}/activity`)
        .set('Authorization', authHeader(manager))
        .expect(200);

      // Newest first: the unassignment should be items[0], the original
      // assignment items[1].
      expect(response.body.total).toBe(2);
      const [unassigned, assigned] = response.body.items as TaskActivityEntry[];
      expect(unassigned).toMatchObject({
        type: TaskActivityType.TASK_ASSIGNEE_CHANGED,
        actor: { id: memberA.id },
        metadata: { from: { id: memberA.id }, to: null },
      });
      expect(assigned).toMatchObject({
        metadata: { from: null, to: { id: memberA.id } },
      });
    });
  });
});
