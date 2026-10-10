import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { randomBytes } from 'node:crypto';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { TestProject } from 'vitest/node';

// Starts one Postgres and one MinIO container per test run. Each test file then works in its
// own database and bucket (test/helpers.ts), so files never share state.

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    s3Endpoint: string;
    s3AccessKey: string;
    s3SecretKey: string;
  }
}

const S3_ACCESS_KEY = 'proctor-test';
const S3_SECRET_KEY = 'proctor-test-secret';

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const started: (StartedPostgreSqlContainer | StartedTestContainer)[] = [];
  try {
    const [postgres, minio] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine').start(),
      new GenericContainer('cgr.dev/chainguard/minio:latest')
        .withCommand(['server', '/data'])
        .withEnvironment({
          MINIO_ROOT_USER: S3_ACCESS_KEY,
          MINIO_ROOT_PASSWORD: S3_SECRET_KEY,
          // A static KMS key enables SSE-S3 (encryption at rest) in MinIO.
          MINIO_KMS_SECRET_KEY: `test-key:${randomBytes(32).toString('base64')}`,
        })
        .withExposedPorts(9000)
        .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000))
        .start(),
    ]);
    started.push(postgres, minio);
    project.provide('databaseUrl', postgres.getConnectionUri());
    project.provide('s3Endpoint', `http://${minio.getHost()}:${String(minio.getMappedPort(9000))}`);
    project.provide('s3AccessKey', S3_ACCESS_KEY);
    project.provide('s3SecretKey', S3_SECRET_KEY);
  } catch (error) {
    await Promise.all(started.map((c) => c.stop()));
    throw new Error(`integration tests need Docker running: ${String(error)}`, { cause: error });
  }
  return async () => {
    await Promise.all(started.map((c) => c.stop()));
  };
}
