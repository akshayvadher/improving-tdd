import type { FileStorageGateway, PutResult, StoredFile } from './file-storage-gateway.js';

export class InMemoryFileStorageGateway implements FileStorageGateway {
  private readonly entries = new Map<string, StoredFile>();

  async put(contentHash: string, bytes: Uint8Array, mimeType: string): Promise<PutResult> {
    if (this.entries.has(contentHash)) {
      return { contentHash, alreadyExisted: true };
    }
    this.entries.set(contentHash, { bytes: new Uint8Array(bytes), mimeType });
    return { contentHash, alreadyExisted: false };
  }

  async get(contentHash: string): Promise<StoredFile | null> {
    const stored = this.entries.get(contentHash);
    if (!stored) {
      return null;
    }
    return { bytes: new Uint8Array(stored.bytes), mimeType: stored.mimeType };
  }

  async remove(contentHash: string): Promise<void> {
    this.entries.delete(contentHash);
  }
}
