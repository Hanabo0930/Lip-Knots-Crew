'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const GAS_LOCK_SOURCE_HASH = 'f36532063ea5add7849568634589458dea1fae60728ef9c177d399e566667d64';
const ROWS = 'monthly_rows';
const rowCase = cells => cells[55]?.userEnteredValue?.stringValue ?? null;

function savedGasLock(sourceFile) {
  const source = fs.readFileSync(sourceFile);
  assert.equal(createHash('sha256').update(source).digest('hex'), GAS_LOCK_SOURCE_HASH);
  const helper = source.toString('utf8').split(/\r?\n/).find(line => line.startsWith('function lkCaseMvpLock_(fn)'));
  assert.ok(helper);
  let locked = false;
  const lock = {
    waitLock(timeout) { assert.equal(timeout, 10_000); assert.equal(locked, false); locked = true; },
    releaseLock() { assert.equal(locked, true); locked = false; },
  };
  const gas = vm.runInNewContext(helper + '\nlkCaseMvpLock_', {
    LockService: { getDocumentLock: () => lock, getScriptLock: () => assert.fail('document lock fixture expected') },
  });
  return { run: gas, get held() { return locked; } };
}

function modelGasLock() {
  let held = false;
  return {
    run(action) {
      assert.equal(held, false);
      held = true;
      try { return action(); }
      finally { held = false; }
    },
    get held() { return held; },
  };
}

function createFile(file) {
  // The running suite owns a new synthetic file and will never replace evidence.
  fs.closeSync(fs.openSync(file, 'wx'));
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE monthly_rows (
        scenario TEXT NOT NULL, position INTEGER NOT NULL, case_id TEXT, cells TEXT NOT NULL,
        PRIMARY KEY (scenario, position)
      );
      CREATE TABLE write_receipts (
        scenario TEXT NOT NULL, intent_id TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (scenario, intent_id)
      );
    `);
  } finally {
    db.close();
  }
}

function connect(file, readOnly = false) {
  const db = new DatabaseSync(file, { readOnly });
  db.exec('PRAGMA busy_timeout=0');
  if (!readOnly) db.exec('PRAGMA synchronous=FULL');
  return db;
}

function openScenario(file, scenario) {
  const reader = connect(file, true);
  const expenseWriter = connect(file);
  const writers = { gas: connect(file), crew: connect(file), manual: connect(file) };
  const fetchRow = (db, position) => {
    const row = db.prepare(`SELECT cells FROM ${ROWS} WHERE scenario=? AND position=?`).get(scenario, position);
    return row ? JSON.parse(row.cells) : undefined;
  };
  const put = (db, position, cells) => db.prepare(`
    INSERT INTO monthly_rows (scenario,position,case_id,cells) VALUES (?,?,?,?)
    ON CONFLICT (scenario,position) DO UPDATE SET case_id=excluded.case_id,cells=excluded.cells
  `).run(scenario, position, rowCase(cells), JSON.stringify(cells));
  const loadReceipt = (db, id) => {
    const row = db.prepare('SELECT body FROM write_receipts WHERE scenario=? AND intent_id=?').get(scenario, id);
    return row ? JSON.parse(row.body) : null;
  };
  const manualTransaction = (db, callback) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      callback(db);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };

  return {
    table: { get: position => fetchRow(reader, position) },
    seed(entries) {
      manualTransaction(writers.crew, db => {
        for (const [position, cells] of entries) put(db, position, cells);
      });
    },
    move(actor, from, to, replacement) {
      manualTransaction(writers[actor], db => {
        const moving = fetchRow(db, from);
        assert.ok(moving);
        put(db, to, moving);
        put(db, from, replacement);
      });
    },
    // Negative control. This simulates an A1 update with no identity condition.
    unsafeSetByPosition(actor, position, index, cell) {
      manualTransaction(writers[actor], db => {
        const cells = fetchRow(db, position);
        cells[index] = cell;
        put(db, position, cells);
      });
    },
    receipt: id => loadReceipt(reader, id),
    makeCrewWriter({ readObservation, intentHash, now, options = {} }) {
      let dispatches = 0;
      return {
        get dispatches() { return dispatches; },
        async compareAndWrite(intent) {
          dispatches++;
          if (options.beforeBegin) await options.beforeBegin();
          const db = expenseWriter;
          db.exec('BEGIN IMMEDIATE');
          try {
            assert.equal(loadReceipt(db, intent.id), null, 'Crew dispatches a given intent at most once');
            const live = await readObservation().catch(() => null);
            const matches = live?.caseListFinancialObservationHash === intent.beforeHash &&
              live.companyId === intent.companyId && live.assignedStaffId === intent.staffId &&
              live.assignedStaffName === intent.staffName && live.dateKey === intent.dateKey &&
              live.revision === intent.jobRevision && live.sheetRef.currentRow === intent.sheetRef.currentRow &&
              now() <= intent.expiresAtMs;
            if (matches) {
              if (options.afterCompare) await options.afterCompare();
              const row = fetchRow(db, intent.sheetRef.currentRow);
              assert.equal(rowCase(row), intent.sheetRef.caseId);
              for (const change of intent.changes) {
                assert.deepEqual(row[change.index].userEnteredValue ?? {}, JSON.parse(JSON.stringify(change.expected)));
                const { userEnteredValue, effectiveValue, ...rest } = row[change.index];
                row[change.index] = Object.hasOwn(change.value, 'numberValue')
                  ? { ...rest, userEnteredValue: change.value, effectiveValue: change.value } : rest;
              }
              const updated=db.prepare(`
                UPDATE monthly_rows SET cells=? WHERE scenario=? AND position=? AND case_id=?
              `).run(JSON.stringify(row), scenario, intent.sheetRef.currentRow, intent.sheetRef.caseId);
              assert.equal(updated.changes, 1);
              if (options.interruptBeforeReceipt) throw new Error('SYNTHETIC_INTERRUPTED_BEFORE_RECEIPT');
            }
            const receipt = {
              intentId: intent.id, intentHash: intentHash(intent), outcome: matches ? 'applied' : 'rejected',
              recordedAtMs: now(),
            };
            db.prepare('INSERT INTO write_receipts (scenario,intent_id,body) VALUES (?,?,?)')
              .run(scenario, intent.id, JSON.stringify(receipt));
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
          if (options.loseResponse) throw new Error('SYNTHETIC_COMMIT_RESPONSE_LOST');
        },
        async readReceipt(id) {
          return options.hideReceipt ? null : loadReceipt(reader, id);
        },
      };
    },
    close() {
      reader.close();
      expenseWriter.close();
      for (const db of Object.values(writers)) db.close();
    },
  };
}

module.exports = { createFile, openScenario, modelGasLock, savedGasLock };
