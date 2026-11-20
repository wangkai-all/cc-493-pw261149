'use strict';
// 数据库连接与 schema。金额一律用整数分（cents），避免浮点误差。
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============ 摄入层：原始消息（幂等） ============
-- 每路来源的每条消息有全局唯一 message_id；重复投递/来源回补只会命中唯一约束被跳过。
CREATE TABLE IF NOT EXISTS source_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,                 -- order | fulfillment | invoice | refund
  message_id  TEXT NOT NULL,
  event_type  TEXT NOT NULL,                 -- order.created / order.amount_revised / fulfillment.delivered / invoice.issued / invoice.red_flushed / refund.completed
  payload     TEXT NOT NULL,                 -- JSON
  occurred_at TEXT NOT NULL,                 -- 业务发生时间
  received_at TEXT NOT NULL,                 -- 摄入时间
  UNIQUE (source, message_id)
);
CREATE INDEX IF NOT EXISTS idx_msg_type ON source_messages(event_type);

-- ============ 规范化业务实体 ============
CREATE TABLE IF NOT EXISTS orders (
  order_id       TEXT PRIMARY KEY,
  current_amount INTEGER NOT NULL,           -- 当前金额（分），随金额修订更新
  status         TEXT NOT NULL DEFAULT 'open',
  created_at     TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1
);

-- 金额修订历史（由 order.amount_revised 消息产生，按 message_id 幂等）
CREATE TABLE IF NOT EXISTS order_revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL REFERENCES orders(order_id),
  old_amount INTEGER NOT NULL,
  new_amount INTEGER NOT NULL,
  revised_at TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE            -- 幂等键：同一修订消息只记一次
);

-- 履约（支持拆单：一个订单多条履约记录，部分发货）
CREATE TABLE IF NOT EXISTS fulfillments (
  fulfillment_id TEXT PRIMARY KEY,           -- 幂等键
  order_id       TEXT NOT NULL REFERENCES orders(order_id),
  line_id        TEXT NOT NULL,
  qty            INTEGER NOT NULL,
  amount         INTEGER NOT NULL,           -- 本次履约确认金额（分）
  delivered_at   TEXT NOT NULL,
  message_id     TEXT NOT NULL UNIQUE
);

-- 发票（红冲用负数发票，red_flush_of 指向原发票）
CREATE TABLE IF NOT EXISTS invoices (
  invoice_id   TEXT PRIMARY KEY,             -- 幂等键
  order_id     TEXT NOT NULL REFERENCES orders(order_id),
  amount       INTEGER NOT NULL,             -- 红冲为负数
  issued_at    TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'normal',  -- normal | red_flush
  red_flush_of TEXT,
  message_id   TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS refunds (
  refund_id   TEXT PRIMARY KEY,              -- 幂等键
  order_id    TEXT NOT NULL REFERENCES orders(order_id),
  amount      INTEGER NOT NULL,
  refunded_at TEXT NOT NULL,
  reason      TEXT,
  message_id  TEXT NOT NULL UNIQUE
);

-- ============ 对账运行（版本化） ============
CREATE TABLE IF NOT EXISTS recon_runs (
  run_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  period        TEXT NOT NULL,               -- YYYY-MM，对账截止该月末
  version       INTEGER NOT NULL,            -- 同一 period 内递增
  status        TEXT NOT NULL DEFAULT 'open',-- open | confirmed（confirmed 后结果冻结）
  triggered_by  TEXT NOT NULL DEFAULT 'system',
  created_at    TEXT NOT NULL,
  confirmed_at  TEXT,
  UNIQUE (period, version)
);

CREATE TABLE IF NOT EXISTS recon_results (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id            INTEGER NOT NULL REFERENCES recon_runs(run_id),
  order_id          TEXT NOT NULL,
  order_amount      INTEGER NOT NULL,        -- 订单当前金额
  recognized_amount INTEGER NOT NULL,        -- 履约确认收入（含调整、扣退款）
  invoiced_amount   INTEGER NOT NULL,        -- 开票净额（含调整、红冲抵减）
  refunded_amount   INTEGER NOT NULL,
  diff              INTEGER NOT NULL,        -- invoiced - recognized
  classification    TEXT NOT NULL,           -- matched | explainable | pending_data | conflict
  rule              TEXT,                    -- 命中规则，如 cross_period / partial_fulfillment / red_flush / amount_revision / invoice_missing ...
  explanation       TEXT,                    -- 人类可读解释
  evidence          TEXT,                    -- JSON：支撑分类的证据（来源记录 id 与金额）
  UNIQUE (run_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_results_run ON recon_results(run_id, classification);

-- ============ 调整（审批流） ============
CREATE TABLE IF NOT EXISTS adjustments (
  adjustment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  result_id     INTEGER NOT NULL REFERENCES recon_results(id),
  order_id      TEXT NOT NULL,
  side          TEXT NOT NULL,               -- recognized | invoiced：调整加到哪条腿
  amount        INTEGER NOT NULL,            -- 有符号金额（分）
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  decided_by    TEXT,
  decided_at    TEXT
);

-- 已生效调整的记账效果：对账时并入对应腿。adjustment_id 唯一 => 审批生效只记一次，杜绝重复记账。
CREATE TABLE IF NOT EXISTS adjustment_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  adjustment_id INTEGER NOT NULL UNIQUE REFERENCES adjustments(adjustment_id),
  order_id      TEXT NOT NULL,
  side          TEXT NOT NULL,
  amount        INTEGER NOT NULL,
  applied_at    TEXT NOT NULL
);

-- ============ 不可变审计账本（哈希链，append-only） ============
CREATE TABLE IF NOT EXISTS audit_ledger (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_type TEXT NOT NULL,                  -- ingest / ingest.duplicate / recon.run / recon.confirm / adjustment.approved / adjustment.rejected / backfill
  ref_id     TEXT NOT NULL,
  payload    TEXT NOT NULL,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 触发器：账本禁止 UPDATE / DELETE，保证不可变
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_ledger
BEGIN SELECT RAISE(ABORT, 'audit_ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_ledger
BEGIN SELECT RAISE(ABORT, 'audit_ledger is append-only'); END;
`;

function openDb(dbPath) {
  const file = dbPath || process.env.RECON_DB || path.join(__dirname, '..', 'data', 'recon.db');
  if (file !== ':memory:') {
    require('node:fs').mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

const now = () => new Date().toISOString();

// 事务助手（node:sqlite 无内置 transaction 方法）
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    throw e;
  }
}

module.exports = { openDb, now, tx };
