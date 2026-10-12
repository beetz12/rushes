import type { DraftStore } from '../contracts';
// Wave-zero import seam; the capture slice implements durable storage.
export async function createDraftStore(_backup?: FileSystemDirectoryHandle): Promise<DraftStore> {
  throw new Error('Draft storage implementation is not integrated yet.');
}
