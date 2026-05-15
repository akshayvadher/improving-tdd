export interface StoredFile {
  bytes: Uint8Array;
  mimeType: string;
}

export interface PutResult {
  contentHash: string;
  alreadyExisted: boolean;
}

export interface FileStorageGateway {
  put(contentHash: string, bytes: Uint8Array, mimeType: string): Promise<PutResult>;
  get(contentHash: string): Promise<StoredFile | null>;
  remove(contentHash: string): Promise<void>;
}
