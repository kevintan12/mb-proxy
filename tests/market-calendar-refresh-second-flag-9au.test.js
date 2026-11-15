'use strict';

// 9AU Build 3: the engine returns applied changes with old and new values, and a SECOND row flagged
// for review is cleared when the OFFICIAL page gives the same date. Saved pages, fake fetch and an
// in-memory fake database. No network, no real database.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {SOURCES, refreshMarketYear} = require('../lib/market-calendar-refresh');

const FIXTURES = path.join(__dirname, 'fixtures', 'market-calendar');
const PAGE = {
  NYSE: fs.readFileSync(path.join(FIXTURES, 'nyse-hours-calendars.html'), 'utf8'),
  NASDAQ: fs.readFileSync(path.join(FIXTURES, 'nasdaq-holiday-schedule.html'), 'utf8')
};
const NOW = () => new Date('2026-01-02T02:00:00Z');

function fakeFetch({fail = []} = {}) {
  const byUrl = {};
  for (const kind of ['official', 'second']) byUrl[SOURCES.US[kind].url] = SOURCES.US[kind].id;
  return async url => {
    const id = byUrl[url];
    if (fail.includes(id)) return {ok: false, status: 503, text: async () => ''};
    return {ok: true, status: 200, text: async () => PAGE[id]};
  };
}

function fakeDatabase() {
  const state = {days: [], nextId: 1, queries: []};
  return {
    state,
    async transaction(callback) {
      const work = JSON.parse(JSON.stringify(state));
      const client = {
        async query(sql, p) {
          const tag = /-- calendar:([a-z-]+)/.exec(sql)[1];
          work.queries.push(tag);
          if (tag === 'select-days') {
            return {rows: work.days.filter(d => d.year === p[1] && !d.retired_at).map(d => ({...d}))};
          }
          if (tag === 'insert-day') {
            work.days.push({id: work.nextId++, year: p[1], calendar_date: p[2], kind: p[3], name: p[4],
              early_close_time: p[5], after_hours_end: p[6], source: p[7], needs_review: p[10], retired_at: null});
          } else if (tag === 'update-day') {
            Object.assign(work.days.find(d => d.id === p[0]), {kind: p[1], early_close_time: p[3], source: p[5], needs_review: true});
          } else if (tag === 'retire-day') {
            Object.assign(work.days.find(d => d.id === p[0]), {retired_at: p[1], needs_review: true});
          } else if (tag === 'flag-day') {
            work.days.find(d => d.id === p[0]).needs_review = true;
          } else if (tag === 'clear-second-flag') {
            const row = work.days.find(d => d.id === p[0] && d.source === 'SECOND');
            if (row) Object.assign(row, {source: 'OFFICIAL', needs_review: false});
          } else if (!['insert-change', 'upsert-year'].includes(tag)) {
            throw new Error(`unexpected query ${tag}`);
          }
          return {rows: []};
        }
      };
      const result = await callback(client);
      Object.assign(state, work);
      return result;
    }
  };
}

async function refresh(db, fetchImpl, year = 2026) {
  return refreshMarketYear({market: 'US', year, fetchImpl, runtime: db, now: NOW});
}

const live = (db, year) => db.state.days.filter(d => d.year === year && !d.retired_at);

test('a flagged SECOND row is cleared when the official page gives the same date', async () => {
  const db = fakeDatabase();
  await refresh(db, fakeFetch({fail: ['NYSE']}));
  assert.ok(live(db, 2026).every(d => d.source === 'SECOND' && d.needs_review === true));
  const result = await refresh(db, fakeFetch());
  assert.equal(result.status, 'SAVED');
  const cleared = new Set((result.clearedFlags || []).map(c => c.date));
  assert.ok(cleared.size > 0, 'at least one date cleared');
  const changed = new Set([...(result.appliedChanges || []), ...result.heldChanges].map(c => c.date));
  for (const row of live(db, 2026)) {
    if (cleared.has(row.calendar_date)) {
      assert.equal(row.source, 'OFFICIAL');
      assert.equal(row.needs_review, false);
      assert.ok(!changed.has(row.calendar_date), 'a changed date is never cleared');
    } else {
      assert.equal(row.needs_review, true, `${row.calendar_date} stays flagged`);
    }
  }
});

test('a SECOND row stays flagged when the official page does not give the date the same way', async () => {
  const db = fakeDatabase();
  await refresh(db, fakeFetch({fail: ['NYSE']}));
  const target = live(db, 2026)[0];
  target.kind = target.kind === 'HOLIDAY' ? 'EARLY_CLOSE' : 'HOLIDAY';
  target.early_close_time = target.kind === 'EARLY_CLOSE' ? '13:00' : null;
  const result = await refresh(db, fakeFetch());
  assert.ok(!(result.clearedFlags || []).some(c => c.date === target.calendar_date));
  assert.equal(live(db, 2026).find(d => d.id === target.id).needs_review, true);
});

test('a second-source read never clears a flag', async () => {
  const db = fakeDatabase();
  await refresh(db, fakeFetch({fail: ['NYSE']}));
  const again = await refresh(db, fakeFetch({fail: ['NYSE']}));
  assert.equal(again.clearedFlags, undefined);
  assert.ok(live(db, 2026).every(d => d.needs_review === true));
  assert.ok(!db.state.queries.includes('clear-second-flag'));
});

test('an already-official unflagged row is left untouched (no clear query)', async () => {
  const db = fakeDatabase();
  await refresh(db, fakeFetch());
  const before = JSON.stringify(live(db, 2026));
  const again = await refresh(db, fakeFetch());
  assert.equal(again.clearedFlags, undefined);
  assert.equal(JSON.stringify(live(db, 2026)), before);
});

test('applied changes come back with date, old and new value; held ones are unchanged', async () => {
  const db = fakeDatabase();
  await refresh(db, fakeFetch());
  const row = live(db, 2026).find(d => d.calendar_date > '2026-03-01');
  const wasKind = row.kind;
  row.kind = wasKind === 'HOLIDAY' ? 'EARLY_CLOSE' : 'HOLIDAY';
  row.early_close_time = row.kind === 'EARLY_CLOSE' ? '13:00' : null;
  const result = await refresh(db, fakeFetch());
  assert.equal(result.saved.updated, 1);
  assert.equal(result.appliedChanges.length, 1);
  const change = result.appliedChanges[0];
  assert.equal(change.date, row.calendar_date);
  assert.equal(change.change, 'UPDATE');
  assert.equal(change.from.kind, row.kind);
  assert.equal(change.to.kind, wasKind);
  assert.deepEqual(result.heldChanges, []);
});

test('a retired date is reported as applied with no new value', async () => {
  const db = fakeDatabase();
  await refresh(db, fakeFetch());
  db.state.days.push({id: 999, year: 2026, calendar_date: '2026-03-03', kind: 'HOLIDAY', name: 'Made up',
    early_close_time: null, after_hours_end: null, source: 'OFFICIAL', needs_review: false, retired_at: null});
  const result = await refresh(db, fakeFetch());
  assert.deepEqual(result.appliedChanges.map(c => [c.date, c.change, c.to]), [['2026-03-03', 'RETIRE', null]]);
});

test('a failed write reports no applied changes and no cleared flags', async () => {
  const db = fakeDatabase();
  await refresh(db, fakeFetch({fail: ['NYSE']}));
  const original = db.transaction.bind(db);
  db.transaction = async callback => original(async client => {
    await callback(client);
    throw new Error('made-up commit failure');
  });
  const result = await refresh(db, fakeFetch());
  assert.equal(result.status, 'ERROR');
  assert.equal(result.clearedFlags, undefined);
  assert.equal(result.appliedChanges, undefined);
});
