import { mkdir, open, lstat, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { freshState, isRecord } from './business.mjs';

const MAX_STATE_BYTES = 8 * 1024 * 1024;

function checkVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error('AWARDS_DATABASE_VERSION_INVALID');
  }
  return value;
}

function encodeState(state) {
  if (!isRecord(state) || !isRecord(state.event)
      || !['setup', 'open', 'closed', 'published'].includes(state.event.phase)
      || ['teams', 'judges', 'voters', 'scores', 'ballots', 'decisions'].some(name => !Array.isArray(state[name]))
      || (Object.hasOwn(state, 'invitations') && (!Array.isArray(state.invitations)
        || state.invitations.length > 10000 || state.invitations.some(item => !isRecord(item))))) {
    throw new Error('AWARDS_DATABASE_STATE_INVALID');
  }
  const encoded = JSON.stringify(state);
  if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) throw new Error('AWARDS_DATABASE_STATE_TOO_LARGE');
  return encoded;
}

export function assertSqliteRuntime() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  // 22.12 is permitted only with its explicit flag, for compatibility tests.
  if (major < 22 || (major === 22 && minor < 13
      && !(minor === 12 && process.execArgv.includes('--experimental-sqlite')))) {
    throw new Error('AWARDS_NODE_22_13_OR_NEWER_REQUIRED');
  }
}

export async function preparePrivateDirectory(dataDir) {
  const directory = resolve(dataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const information = await lstat(directory);
  if (!information.isDirectory() || information.isSymbolicLink()) throw new Error('AWARDS_DATA_DIRECTORY_INVALID');
  await chmod(directory, 0o700);
  return directory;
}

export async function createSqliteStore({ dataDir } = {}) {
  assertSqliteRuntime();
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new Error('AWARDS_DATA_DIRECTORY_REQUIRED');
  const directory = await preparePrivateDirectory(dataDir);
  const databasePath = resolve(directory, 'event.sqlite3');
  // Create with private permissions before SQLite opens it; never follow a link.
  try { const handle = await open(databasePath, 'wx', 0o600); await handle.close(); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const information = await lstat(databasePath);
  if (!information.isFile() || information.isSymbolicLink()) throw new Error('AWARDS_DATABASE_FILE_INVALID');
  await chmod(databasePath, 0o600);
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;');
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(`CREATE TABLE IF NOT EXISTS event_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1)
      )`);
      database.prepare('INSERT OR IGNORE INTO event_state (id, state, version) VALUES (1, ?, 1)')
        .run(encodeState(freshState()));
      const row = database.prepare('SELECT state, version FROM event_state WHERE id = 1').get();
      if (!row) throw new Error('AWARDS_DATABASE_NOT_INITIALIZED');
      checkVersion(row.version);
      encodeState(JSON.parse(row.state));
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }

    const select = database.prepare('SELECT state, version FROM event_state WHERE id = 1');
    const update = database.prepare('UPDATE event_state SET state = ?, version = version + 1 WHERE id = 1 AND version = ?');
    let closed = false;
    const assertOpen = () => { if (closed) throw new Error('AWARDS_DATABASE_CLOSED'); };
    return {
      async read() {
        assertOpen();
        const row = select.get();
        if (!row) throw new Error('AWARDS_DATABASE_NOT_INITIALIZED');
        const state = JSON.parse(row.state);
        encodeState(state);
        return { state, version: checkVersion(row.version) };
      },
      async compareAndSwap(expectedVersion, state) {
        assertOpen();
        const version = checkVersion(expectedVersion), encoded = encodeState(state);
        // A single conditional SQL statement is atomic across processes too.
        return Number(update.run(encoded, version).changes) === 1;
      },
      async close() { if (!closed) { database.close(); closed = true; } },
    };
  } catch (error) { database.close(); throw error; }
}
