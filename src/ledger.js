'use strict';
// 不可变审计账本：哈希链 append-only。每条记录 hash = sha256(prev_hash | entry_type | ref_id | payload | created_at)
const crypto = require('node:crypto');
const { now } = require('./db');

function computeHash(prevHash, entryType, refId, payload, createdAt) {
  return crypto
    .createHash('sha256')
    .update([prevHash, entryType, refId, payload, createdAt].join('|'))
    .digest('hex');
}

// 追加一条审计记录。调用方应在事务内使用。
function append(db, entryType, refId, payloadObj) {
  const last = db.prepare('SELECT hash FROM audit_ledger ORDER BY seq DESC LIMIT 1').get();
  const prevHash = last ? last.hash : 'GENESIS';
  const payload = JSON.stringify(payloadObj);
  const createdAt = now();
  const hash = computeHash(prevHash, entryType, String(refId), payload, createdAt);
  const info = db
    .prepare(
      `INSERT INTO audit_ledger (entry_type, ref_id, payload, prev_hash, hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(entryType, String(refId), payload, prevHash, hash, createdAt);
  return { seq: Number(info.lastInsertRowid), hash, prevHash };
}

// 校验整条链：逐条重算哈希并核对 prev_hash 衔接
function verifyChain(db) {
  const rows = db.prepare('SELECT * FROM audit_ledger ORDER BY seq ASC').all();
  let prevHash = 'GENESIS';
  for (const row of rows) {
    const expect = computeHash(row.prev_hash, row.entry_type, row.ref_id, row.payload, row.created_at);
    if (row.prev_hash !== prevHash) {
      return { ok: false, at: row.seq, reason: `prev_hash 断链: 期望 ${prevHash}, 实际 ${row.prev_hash}` };
    }
    if (expect !== row.hash) {
      return { ok: false, at: row.seq, reason: `hash 校验失败: 期望 ${expect}, 实际 ${row.hash}` };
    }
    prevHash = row.hash;
  }
  return { ok: true, entries: rows.length, head: prevHash };
}

module.exports = { append, verifyChain, computeHash };
