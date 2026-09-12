import type { INestApplication } from '@nestjs/common';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { OrganizationRole, ProjectRole, TaskPriority, TaskStatus } from '@projectflow/shared';
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

describe('Tasks', () => {
  let app: INestApplication;
  let connection: Connection;

  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let projectId: string;

  beforeAll(async () => {
    ({ app, connection } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(connection);

    owner = await registerUser(app, 'Ammar Yaser', 'ammar@example.com');
    member = await registerUser(app, 'Magd Ali', 'magd@example.com');
    outsider = await registerUser(app, 'Outside User', 'outside@example.com');

    const organizationId = await createOrganization(
      connection,
      'Acme Software',
      'acme-software',
      owner.id,
    );
    await addOrganizationMember(connection, organizationId, owner.id, OrganizationRole.OWNER);
    await addOrganizationMember(connection, organizationId, member.id, OrganizationRole.MEMBER);

    projectId = await createProject(
      connection,
      organizationId,
      'Internal Platform',
      'ENG',
      owner.id,
    );
    await addProjectMember(connection, projectId, member.id, ProjectRole.MEMBER);
  });

  it('lets a project member create a task', async () => {
    const response = await request(app.getHttpServer())
      .post(`/projects/${projectId}/tasks`)
      .set('Authorization', authHeader(member))
      .send({
        title: 'Improve API error handling',
        description: 'Normalise validation and permission errors.',
        priority: TaskPriority.HIGH,
      })
      .expect(201);

    expect(response.body).toMatchObject({
      key: 'ENG-1',
      number: 1,
      title: 'Improve API error handling',
      status: TaskStatus.TODO,
      priority: TaskPriority.HIGH,
    });
    expect(response.body.createdBy).toMatchObject({ email: 'magd@example.com' });
  });

  it('numbers tasks sequentially within a project', async () => {
    for (const title of ['First task', 'Second task', 'Third task']) {
      await request(app.getHttpServer())
        .post(`/projects/${projectId}/tasks`)
        .set('Authorization', authHeader(member))
        .send({ title })
        .expect(201);
    }

    const response = await request(app.getHttpServer())
      .get(`/projects/${projectId}/tasks`)
      .set('Authorization', authHeader(member))
      .expect(200);

    expect(response.body.total).toBe(3);
    expect(response.body.items.map((task: { key: string }) => task.key)).toEqual([
      'ENG-1',
      'ENG-2',
      'ENG-3',
    ]);
  });

  it('assigns unique, gap-free task numbers under concurrent creation', async () => {
    // Regression coverage for the reported race: the previous
    // `countDocuments` + `count + 1` approach reads and writes in two
    // separate steps, so firing many creates at once (interleaved by
    // Node's event loop the same way concurrent HTTP requests would be)
    // could let two of them observe the same count. The fix makes issuing a
    // number a single atomic `$inc`, so this must always come out unique.
    const CONCURRENT_REQUESTS = 10;

    // Explicitly listen on a random port so the server is fully ready
    // before we fire concurrent requests. Without this, supertest lazily
    // binds the server on first use, and 10 simultaneous requests can
    // overwhelm that lazy binding with ECONNRESET errors.
    const httpServer = app.getHttpServer();
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    try {
      const agent = request.agent(httpServer);

      const responses = await Promise.all(
        Array.from({ length: CONCURRENT_REQUESTS }, (_, index) =>
          agent
            .post(`/projects/${projectId}/tasks`)
            .set('Authorization', authHeader(member))
            .send({ title: `Concurrent task ${index}` }),
        ),
      );

      for (const response of responses) {
        expect(response.status).toBe(201);
      }

      const numbers = responses.map((response) => response.body.number as number);
      expect(new Set(numbers).size).toBe(CONCURRENT_REQUESTS);
      expect([...numbers].sort((a, b) => a - b)).toEqual(
        Array.from({ length: CONCURRENT_REQUESTS }, (_, index) => index + 1),
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err: Error | undefined) => (err ? reject(err) : resolve())),
      );
    }
  });

  it('refuses to create a task for someone outside the project', async () => {
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/tasks`)
      .set('Authorization', authHeader(outsider))
      .send({ title: 'Should not be created' })
      .expect(403);
  });

  it('refuses to list tasks for someone outside the project', async () => {
    await request(app.getHttpServer())
      .get(`/projects/${projectId}/tasks`)
      .set('Authorization', authHeader(outsider))
      .expect(403);
  });

  it('rejects a task without a usable title', async () => {
    const response = await request(app.getHttpServer())
      .post(`/projects/${projectId}/tasks`)
      .set('Authorization', authHeader(member))
      .send({ title: 'ab' })
      .expect(400);

    expect(response.body.statusCode).toBe(400);
  });

  it('filters the task list by status', async () => {
    await request(app.getHttpServer())
      .post(`/projects/${projectId}/tasks`)
      .set('Authorization', authHeader(member))
      .send({ title: 'Work in flight', status: TaskStatus.IN_PROGRESS })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/projects/${projectId}/tasks`)
      .set('Authorization', authHeader(member))
      .send({ title: 'Not started yet' })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get(`/projects/${projectId}/tasks`)
      .query({ status: TaskStatus.IN_PROGRESS })
      .set('Authorization', authHeader(member))
      .expect(200);

    expect(response.body.total).toBe(1);
    expect(response.body.items[0]).toMatchObject({ title: 'Work in flight' });
  });

  describe('PATCH /tasks/:taskId/status', () => {
    // Regression coverage for the reported production bug: "some users
    // appear to be able to modify tasks belonging to projects they are not
    // members of". Root cause was that this endpoint never checked project
    // access at all — see BUG_REPORT.md.
    it('refuses to change status for someone outside the project', async () => {
      const taskId = await createTask(
        connection,
        projectId,
        'ENG',
        1,
        'Ship the release',
        owner.id,
      );

      await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/status`)
        .set('Authorization', authHeader(outsider))
        .send({ status: TaskStatus.DONE })
        .expect(403);
    });

    it('lets a project member change task status', async () => {
      const taskId = await createTask(
        connection,
        projectId,
        'ENG',
        1,
        'Ship the release',
        owner.id,
      );

      const response = await request(app.getHttpServer())
        .patch(`/tasks/${taskId}/status`)
        .set('Authorization', authHeader(member))
        .send({ status: TaskStatus.DONE })
        .expect(200);

      expect(response.body.status).toBe(TaskStatus.DONE);
    });
  });
});
