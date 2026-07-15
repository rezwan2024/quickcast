import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

interface QuickCastDB extends DBSchema {
  chunks: {
    key: [string, number];
    value: { recordingId: string; index: number; blob: Blob };
    indexes: { 'by-recording': string };
  };
}

let dbPromise: Promise<IDBPDatabase<QuickCastDB>> | undefined;

function getDb() {
  dbPromise ??= openDB<QuickCastDB>('quickcast-recordings', 1, {
    upgrade(db) {
      const store = db.createObjectStore('chunks', { keyPath: ['recordingId', 'index'] });
      store.createIndex('by-recording', 'recordingId');
    },
  });
  return dbPromise;
}

export async function addChunk(recordingId: string, index: number, blob: Blob) {
  const db = await getDb();
  await db.put('chunks', { recordingId, index, blob });
}

export async function getChunks(recordingId: string): Promise<Blob[]> {
  const db = await getDb();
  const entries = await db.getAllFromIndex('chunks', 'by-recording', recordingId);
  return entries.sort((a, b) => a.index - b.index).map((entry) => entry.blob);
}

export async function deleteRecording(recordingId: string) {
  const db = await getDb();
  const tx = db.transaction('chunks', 'readwrite');
  const keys = await tx.store.index('by-recording').getAllKeys(recordingId);
  await Promise.all([...keys.map((key) => tx.store.delete(key)), tx.done]);
}
