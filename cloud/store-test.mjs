import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresStore, TABLE, RECORD_ID } from './store.mjs';

function database() {
  let row = null;
  const operations = [];
  let failWrite = false;
  const app = { rdb: () => ({
    from(table) {
      assert.equal(table, TABLE);
      const filters = new Map();
      let action = 'read', values, columns;
      const builder = {
        select(value) { columns = value; return builder; },
        eq(field, value) { filters.set(field, value); return builder; },
        insert(value) { action = 'insert'; values = value; return builder; },
        update(value) { action = 'update'; values = value; return builder; },
        then(resolve, reject) {
          try {
            operations.push({ table, action, filters: new Map(filters) });
            if (action !== 'read' && failWrite) throw new Error('SIMULATED_TRANSPORT_UNKNOWN');
            if (action === 'insert') {
              if (row) return resolve({ error: { code: '23505' }, data: null });
              row = structuredClone(values);
              return resolve({ data: [{ id: row.id }], error: null });
            }
            if (filters.get('id') !== RECORD_ID) throw new Error('MISSING_ID_FILTER');
            if (action === 'update') {
              assert.equal(columns, 'id');
              if (!row || row.version !== filters.get('version')) return resolve({ data: [], error: null });
              row = structuredClone({ ...row, ...values });
              return resolve({ data: [{ id: row.id }], error: null });
            }
            return resolve({ data: row ? [structuredClone(row)] : [], error: null });
          } catch (error) { return reject(error); }
        },
      };
      return builder;
    },
  }) };
  return { app, operations, failWrites() { failWrite = true; } };
}

test('PostgreSQL adapter initializes only its own table and row', async () => {
  const db = database();
  const [first, second] = await Promise.all([
    createPostgresStore({ app: db.app }), createPostgresStore({ app: db.app }),
  ]);
  assert.deepEqual(await first.read(), await second.read());
  const { state, version } = await first.read();
  assert.equal(version, 1);
  assert.deepEqual(state.teams, []);
  assert.ok(db.operations.every(item => item.table === 'city_event_private_v1'));
});

test('database conditional update refuses stale versions without overwriting the winner', async () => {
  const db = database(), store = await createPostgresStore({ app: db.app });
  const one = await store.read(), two = await store.read();
  one.state.event.name = 'first';
  two.state.event.name = 'stale';
  assert.equal(await store.compareAndSwap(one.version, one.state), true);
  assert.equal(await store.compareAndSwap(two.version, two.state), false);
  const saved = await store.read();
  assert.equal(saved.version, 2);
  assert.equal(saved.state.event.name, 'first');
  assert.ok(db.operations.filter(item => item.action === 'update').every(item =>
    item.filters.has('id') && item.filters.has('version')));
});

test('unknown database write outcomes fail; they never switch to process memory', async () => {
  const db = database(), store = await createPostgresStore({ app: db.app });
  const previous = await store.read();
  db.failWrites();
  previous.state.event.name = 'not confirmed';
  await assert.rejects(store.compareAndSwap(previous.version, previous.state));
  assert.notEqual((await store.read()).state.event.name, 'not confirmed');
});

test('production store refuses missing environment or access key', async () => {
  await assert.rejects(createPostgresStore({ env: {} }), /CONFIG_MISSING/);
  await assert.rejects(createPostgresStore({ env: { CLOUDBASE_ENV_ID: 'fake-test-env' } }), /CONFIG_MISSING/);
});
