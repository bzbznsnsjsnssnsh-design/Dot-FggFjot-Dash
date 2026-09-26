import { Storage } from "@google-cloud/storage";

const storage = new Storage();

function getBucket() {
  const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!bucketId) {
    throw new Error("Object Storage has not been configured for OpenAI dubbing.");
  }
  return storage.bucket(bucketId);
}

export async function storeFile(
  objectKey: string,
  localPath: string,
  contentType: string,
): Promise<void> {
  await getBucket().upload(localPath, {
    destination: objectKey,
    resumable: false,
    metadata: { contentType },
  });
}

export async function storeBuffer(
  objectKey: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  await getBucket().file(objectKey).save(buffer, {
    resumable: false,
    metadata: { contentType },
  });
}

export function objectReadStream(
  objectKey: string,
  range?: { start: number; end: number },
) {
  return getBucket().file(objectKey).createReadStream(range);
}

export async function getObjectMetadata(objectKey: string) {
  const [metadata] = await getBucket().file(objectKey).getMetadata();
  return metadata;
}

export async function deleteStoredObject(objectKey: string): Promise<void> {
  await getBucket().file(objectKey).delete({ ignoreNotFound: true });
}