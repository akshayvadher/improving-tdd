import { describe, expect, it } from 'vitest';

import type { FileStorageGateway } from './file-storage-gateway.js';
import { InMemoryFileStorageGateway } from './in-memory-file-storage-gateway.js';

function jpegMagicBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
}

function pngMagicBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

describe('InMemoryFileStorageGateway', () => {
  it('writes the bytes and reports alreadyExisted=false when put is called for a new hash', async () => {
    // given a fresh gateway with no entries
    const gateway = new InMemoryFileStorageGateway();
    const bytes = jpegMagicBytes();

    // when put is called for a hash not yet stored
    const result = await gateway.put('abc123', bytes, 'image/jpeg');

    // then the result echoes the hash and reports the bytes as new
    expect(result).toEqual({ contentHash: 'abc123', alreadyExisted: false });
    // and a subsequent get returns the stored entry
    const stored = await gateway.get('abc123');
    expect(stored).not.toBeNull();
    expect(stored?.mimeType).toBe('image/jpeg');
    expect(bytesEqual(stored!.bytes, bytes)).toBe(true);
  });

  it('does not overwrite and reports alreadyExisted=true when put is called twice for the same hash', async () => {
    // given a gateway that already has bytesA stored under hash H
    const gateway = new InMemoryFileStorageGateway();
    const bytesA = jpegMagicBytes();
    const bytesB = pngMagicBytes();
    await gateway.put('abc123', bytesA, 'image/jpeg');

    // when put is called again for the same hash with different bytes
    const result = await gateway.put('abc123', bytesB, 'image/png');

    // then the result reports alreadyExisted=true
    expect(result).toEqual({ contentHash: 'abc123', alreadyExisted: true });
    // and the stored bytes still equal bytesA (no overwrite)
    const stored = await gateway.get('abc123');
    expect(stored).not.toBeNull();
    expect(bytesEqual(stored!.bytes, bytesA)).toBe(true);
    expect(stored?.mimeType).toBe('image/jpeg');
  });

  it('returns byte-identical bytes and the original mimeType from get when a hash is stored', async () => {
    // given a gateway with a stored entry
    const gateway = new InMemoryFileStorageGateway();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    await gateway.put('deadbeef', bytes, 'image/jpeg');

    // when get is called with that hash
    const stored = await gateway.get('deadbeef');

    // then it returns byte-identical bytes and the original mimeType
    expect(stored).not.toBeNull();
    expect(stored?.mimeType).toBe('image/jpeg');
    expect(stored!.bytes.byteLength).toBe(bytes.byteLength);
    for (let i = 0; i < bytes.byteLength; i += 1) {
      expect(stored!.bytes[i]).toBe(bytes[i]);
    }
  });

  it('returns null from get for a hash that was never stored', async () => {
    // given a fresh gateway with no entries
    const gateway = new InMemoryFileStorageGateway();

    // when get is called for an unknown hash
    const stored = await gateway.get('unknown-hash');

    // then null is returned
    expect(stored).toBeNull();
  });

  it('causes the next get to return null after remove on a stored hash', async () => {
    // given a gateway with a stored entry
    const gateway = new InMemoryFileStorageGateway();
    await gateway.put('abc123', pngMagicBytes(), 'image/png');

    // when remove is called for that hash
    await gateway.remove('abc123');

    // then the next get for that hash returns null
    expect(await gateway.get('abc123')).toBeNull();
  });

  it('resolves without throwing when remove is called for an unknown hash', async () => {
    // given a fresh gateway with no entries
    const gateway = new InMemoryFileStorageGateway();

    // when / then remove on an unknown hash resolves without throwing
    await expect(gateway.remove('never-stored')).resolves.toBeUndefined();
  });

  it('does not let a caller mutate stored bytes through the input array passed to put', async () => {
    // given a gateway and a mutable input array
    const gateway = new InMemoryFileStorageGateway();
    const input = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    await gateway.put('abc123', input, 'image/jpeg');

    // when the caller mutates the input array after put returned
    input[0] = 0x00;
    input[1] = 0x00;

    // then the stored bytes are unaffected (defensive copy on write)
    const stored = await gateway.get('abc123');
    expect(stored).not.toBeNull();
    expect(bytesEqual(stored!.bytes, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
  });

  it('does not let a caller mutate stored bytes through an array returned by get', async () => {
    // given a gateway with a stored entry
    const gateway = new InMemoryFileStorageGateway();
    await gateway.put('abc123', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg');

    // when the caller mutates the bytes returned by the first get
    const firstRead = await gateway.get('abc123');
    expect(firstRead).not.toBeNull();
    firstRead!.bytes[0] = 0x00;
    firstRead!.bytes[1] = 0x00;

    // then a second get returns the original, unmutated bytes (defensive copy on read)
    const secondRead = await gateway.get('abc123');
    expect(secondRead).not.toBeNull();
    expect(bytesEqual(secondRead!.bytes, new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
  });

  it('satisfies the FileStorageGateway port (put, get, remove signatures)', async () => {
    // given a fresh InMemoryFileStorageGateway typed as the port
    const gateway: FileStorageGateway = new InMemoryFileStorageGateway();

    // when each method is called through the port type
    // then each returns a Promise (await resolves) — the assignment above is the
    // compile-time proof that the in-memory class implements the port.
    await expect(gateway.put('abc123', jpegMagicBytes(), 'image/jpeg')).resolves.toEqual({
      contentHash: 'abc123',
      alreadyExisted: false,
    });
    await expect(gateway.get('abc123')).resolves.not.toBeNull();
    await expect(gateway.remove('abc123')).resolves.toBeUndefined();
  });
});
