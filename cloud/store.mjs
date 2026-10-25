import { freshState, isRecord } from './business.mjs';

// This deployment is deliberately incapable of choosing another application's table.
export const TABLE = 'city_event_private_v1';
export const RECORD_ID = 'event';
function rows(result) {
  if (!result || result.error || !Array.isArray(result.data)) throw new Error('AWARDS_DATABASE_REQUEST_FAILED');
  return result.data;
}
function checkVersion(value) {
  const version = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(version) || version < 0 || version >= Number.MAX_SAFE_INTEGER) throw new Error('AWARDS_DATABASE_VERSION_INVALID');
  return version;
}
function checkState(state) {
  if (!isRecord(state) || !isRecord(state.event)
      || !['setup', 'open', 'closed', 'published'].includes(state.event.phase)
      || ['teams', 'judges', 'voters', 'scores', 'ballots', 'decisions'].some(name => !Array.isArray(state[name]))) {
    throw new Error('AWARDS_DATABASE_STATE_INVALID');
  }
  if (Object.hasOwn(state, 'invitations') && (!Array.isArray(state.invitations) || state.invitations.length > 10000
      || state.invitations.some(item => !isRecord(item)))) throw new Error('AWARDS_DATABASE_STATE_INVALID');
  const encoded = JSON.stringify(state);
  if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw new Error('AWARDS_DATABASE_STATE_TOO_LARGE');
  return state;
}
export async function createPostgresStore({ env = process.env, app } = {}) {
  if (!app) {
    if (!env.CLOUDBASE_ENV_ID || !env.CLOUDBASE_API_KEY) throw new Error('AWARDS_DATABASE_CONFIG_MISSING');
    const imported = await import('@cloudbase/js-sdk');
    const sdk = imported.default || imported;
    app = sdk.init({ env: env.CLOUDBASE_ENV_ID, accessKey: env.CLOUDBASE_API_KEY });
  }
  const db = app.rdb();
  const fetchRow = async () => {
    const found = rows(await db.from(TABLE).select('id,state,version').eq('id', RECORD_ID));
    if (found.length > 1) throw new Error('AWARDS_DATABASE_RESPONSE_INVALID');
    if (!found.length) return null;
    const row = found[0];
    if (row.id !== RECORD_ID) throw new Error('AWARDS_DATABASE_RESPONSE_INVALID');
    return { state: checkState(row.state), version: checkVersion(row.version) };
  };
  const store = {
    async read() {
      const row = await fetchRow();
      if (!row) throw new Error('AWARDS_DATABASE_NOT_INITIALIZED');
      return { state: structuredClone(row.state), version: row.version };
    },
    async compareAndSwap(expectedVersion, state) {
      const version = checkVersion(expectedVersion);
      checkState(state);
      // PostgreSQL performs the version predicate and update atomically.
      const changed = rows(await db.from(TABLE)
        .update({ state, version: version + 1 })
        .eq('id', RECORD_ID).eq('version', version).select('id'));
      if (changed.length > 1 || changed.some(row => row.id !== RECORD_ID)) throw new Error('AWARDS_DATABASE_RESPONSE_INVALID');
      return changed.length === 1;
    },
  };
  if (!await fetchRow()) {
    try {
      const inserted = rows(await db.from(TABLE).insert({ id: RECORD_ID, state: freshState(), version: 1 }).select('id'));
      if (inserted.length !== 1 || inserted[0].id !== RECORD_ID) throw new Error('AWARDS_DATABASE_RESPONSE_INVALID');
    } catch {
      // Concurrent cold starts may both insert. Only an actual stored row
      // confirms initialization; failed database calls never fall back to RAM.
      if (!await fetchRow()) throw new Error('AWARDS_DATABASE_INITIALIZATION_FAILED');
    }
  }
  return store;
}
