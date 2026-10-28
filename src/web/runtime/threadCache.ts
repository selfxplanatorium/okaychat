// Read-through cache of raw `GET /threads/:id/messages` rows, so a reload, PWA cold start, or deep link can paint a
// chat before the server answers. In-session switching never reaches it: assistant-ui keeps loaded threads in memory.
//
// The server stays authoritative. Rows are only written from a successful server response, any successful message
// write drops the thread's entry instead of patching it, and RuntimeProvider swaps the painted rows for the server's
// and blocks sending until that load settles, so a reply can never be parented on a cached message.
//
// Only the newest MAX_ROWS messages of the current branch are kept: enough to fill the screen while the full history
// loads, and small enough that 30 entries stay cheap. Chats without activity for MAX_AGE_MS are not cached.
//
// Every failure (private mode, disabled storage, quota) resolves like a miss, so callers never see a rejection.

const DB_NAME = "okaychat-thread-cache";
const STORE = "messages";
const MAX_ENTRIES = 30;
const MAX_ROWS = 20;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type Row = { id: string; parent_id: string | null };
type Entry = { rows: Row[]; savedAt: number; activeAt: number };

let db: Promise<IDBDatabase | null> | undefined;

function openDb(): Promise<IDBDatabase | null> {
  return (db ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE).createIndex("savedAt", "savedAt");
      req.onsuccess = () => {
        // Another tab signing out deletes the database; holding the connection open would block it.
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));
}

function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then(
    (conn) =>
      new Promise<T | undefined>((resolve) => {
        if (!conn) return resolve(undefined);
        try {
          const tx = conn.transaction(STORE, mode);
          const req = body(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req ? req.result : undefined);
          tx.onerror = () => resolve(undefined);
          tx.onabort = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

const isRecent = (activeAt: number) => Date.now() - activeAt < MAX_AGE_MS;

/** The newest message and its ancestors, oldest first, cut to the last MAX_ROWS with the first one made a root. */
export function branchTail<T extends Row>(rows: T[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const branch: T[] = [];
  for (let row = rows.at(-1); row && branch.length < MAX_ROWS; row = row.parent_id ? byId.get(row.parent_id) : undefined) {
    branch.push(row);
  }
  branch.reverse();
  // assistant-ui drops a message whose parent it has not seen, which would cascade through the whole tail.
  if (branch[0]?.parent_id) branch[0] = { ...branch[0], parent_id: null };
  return branch;
}

export async function readThread<T extends Row>(threadId: string): Promise<T[] | undefined> {
  const entry = (await run<Entry | undefined>("readonly", (store) => store.get(threadId))) as Entry | undefined;
  if (!entry || !Array.isArray(entry.rows)) return undefined;
  if (isRecent(entry.activeAt)) return entry.rows as T[];
  void dropThread(threadId);
  return undefined;
}

/** `activeAt` is the chat's last message activity; older or unknown chats are dropped instead of stored. */
export async function writeThread(threadId: string, rows: Row[], activeAt: number | undefined): Promise<void> {
  if (activeAt === undefined || !isRecent(activeAt) || rows.length === 0) return dropThread(threadId);
  await run("readwrite", (store) => {
    store.put({ rows: branchTail(rows), savedAt: Date.now(), activeAt } satisfies Entry, threadId);
    const count = store.count();
    count.onsuccess = () => {
      let excess = count.result - MAX_ENTRIES;
      const cutoff = Date.now() - MAX_AGE_MS;
      const cursor = store.index("savedAt").openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        if (excess > 0 || (current.value as Entry).activeAt <= cutoff) {
          current.delete();
          excess--;
        }
        current.continue();
      };
    };
  });
}

export async function dropThread(threadId: string): Promise<void> {
  await run("readwrite", (store) => store.delete(threadId));
}

/** Sign-out: the next account on this browser must not find the previous one's messages. */
export async function clearThreadCache(): Promise<void> {
  const conn = await db?.catch(() => null);
  conn?.close();
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
  db = undefined;
}
