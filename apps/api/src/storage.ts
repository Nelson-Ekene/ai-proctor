import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** Evidence object storage. The bucket is private: reviewers only get short-lived signed URLs. */
export interface EvidenceStorage {
  ensureBucket(): Promise<void>;
  /** Stores an object encrypted at rest (SSE). */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  remove(keys: readonly string[]): Promise<void>;
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
  /** Server-side encryption reported for a stored object (tests and diagnostics). */
  encryption(key: string): Promise<string | undefined>;
}

export interface S3Options {
  endpoint: string;
  publicEndpoint?: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function client(endpoint: string, o: S3Options): S3Client {
  return new S3Client({
    endpoint,
    region: o.region,
    forcePathStyle: true, // MinIO
    credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
  });
}

export function createS3Storage(o: S3Options): EvidenceStorage {
  const s3 = client(o.endpoint, o);
  const signer = o.publicEndpoint ? client(o.publicEndpoint, o) : s3;
  const Bucket = o.bucket;

  return {
    async ensureBucket() {
      try {
        await s3.send(new HeadBucketCommand({ Bucket }));
      } catch {
        await s3.send(new CreateBucketCommand({ Bucket }));
      }
    },
    async put(key, body, contentType) {
      await s3.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ServerSideEncryption: 'AES256',
        }),
      );
    },
    async remove(keys) {
      // DeleteObjects takes at most 1000 keys per call.
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000);
        const res = await s3.send(
          new DeleteObjectsCommand({
            Bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        if (res.Errors && res.Errors.length > 0) {
          throw new Error(`failed to delete ${String(res.Errors.length)} evidence objects`);
        }
      }
    },
    signedUrl(key, ttlSeconds) {
      return getSignedUrl(signer, new GetObjectCommand({ Bucket, Key: key }), {
        expiresIn: ttlSeconds,
      });
    },
    async encryption(key) {
      const head = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
      return head.ServerSideEncryption;
    },
  };
}
