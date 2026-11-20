'use strict';
// 摄入层：四路来源消息统一入口。
// 幂等保证：(source, message_id) 唯一约束 —— 重复投递与来源回补不会重复记账；
// 规范化实体同样以业务键唯一约束兜底（fulfillment_id / invoice_id / refund_id / message_id）。
const { now, tx } = require('./db');
const ledger = require('./ledger');

const VALID_SOURCES = new Set(['order', 'fulfillment', 'invoice', 'refund']);

function cents(v) {
  // 接受元（number，最多两位小数）或分（整数，字段名带 _cents 时调用方已处理）
  if (!Number.isFinite(v)) throw new Error(`金额非法: ${v}`);
  return Math.round(v * 100);
}

// 规范化：把消息写入业务实体表。全部幂等。
const normalizers = {
  'order.created'(db, p, msg) {
    db.prepare(
      `INSERT INTO orders (order_id, current_amount, status, created_at)
       VALUES (?, ?, 'open', ?)
       ON CONFLICT(order_id) DO NOTHING`
    ).run(p.order_id, cents(p.amount), msg.occurred_at);
  },
  'order.amount_revised'(db, p, msg) {
    // 金额修订：记历史 + 更新当前值。message_id 唯一 => 重复修订消息只生效一次。
    const order = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(p.order_id);
    if (!order) throw new Error(`修订的订单不存在: ${p.order_id}`);
    const r = db
      .prepare(
        `INSERT INTO order_revisions (order_id, old_amount, new_amount, revised_at, message_id)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING`
      )
      .run(p.order_id, order.current_amount, cents(p.new_amount), msg.occurred_at, msg.message_id);
    if (r.changes > 0) {
      db.prepare('UPDATE orders SET current_amount = ?, version = version + 1 WHERE order_id = ?').run(
        cents(p.new_amount),
        p.order_id
      );
    }
  },
  'fulfillment.delivered'(db, p, msg) {
    db.prepare(
      `INSERT INTO fulfillments (fulfillment_id, order_id, line_id, qty, amount, delivered_at, message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(fulfillment_id) DO NOTHING`
    ).run(p.fulfillment_id, p.order_id, p.line_id, p.qty, cents(p.amount), msg.occurred_at, msg.message_id);
  },
  'invoice.issued'(db, p, msg) {
    db.prepare(
      `INSERT INTO invoices (invoice_id, order_id, amount, issued_at, kind, message_id)
       VALUES (?, ?, ?, ?, 'normal', ?) ON CONFLICT(invoice_id) DO NOTHING`
    ).run(p.invoice_id, p.order_id, cents(p.amount), msg.occurred_at, msg.message_id);
  },
  'invoice.red_flushed'(db, p, msg) {
    // 红冲：负数发票，red_flush_of 指向原发票
    db.prepare(
      `INSERT INTO invoices (invoice_id, order_id, amount, issued_at, kind, red_flush_of, message_id)
       VALUES (?, ?, ?, ?, 'red_flush', ?, ?) ON CONFLICT(invoice_id) DO NOTHING`
    ).run(p.invoice_id, p.order_id, -Math.abs(cents(p.amount)), msg.occurred_at, p.red_flush_of, msg.message_id);
  },
  'refund.completed'(db, p, msg) {
    db.prepare(
      `INSERT INTO refunds (refund_id, order_id, amount, refunded_at, reason, message_id)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(refund_id) DO NOTHING`
    ).run(p.refund_id, p.order_id, cents(p.amount), msg.occurred_at, p.reason || null, msg.message_id);
  },
};

/**
 * 摄入单条消息。
 * @returns {{status:'inserted'|'duplicate', seq?:number}}
 */
function ingest(db, msg) {
  const { source, message_id, event_type, payload, occurred_at } = msg;
  if (!VALID_SOURCES.has(source)) throw new Error(`未知来源: ${source}`);
  if (!message_id || !event_type || !payload || !occurred_at) throw new Error('消息缺少必填字段');
  const normalizer = normalizers[event_type];
  if (!normalizer) throw new Error(`未知事件类型: ${event_type}`);

  return tx(db, () => {
    const r = db
      .prepare(
        `INSERT INTO source_messages (source, message_id, event_type, payload, occurred_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source, message_id) DO NOTHING`
      )
      .run(source, message_id, event_type, JSON.stringify(payload), occurred_at, now());

    if (r.changes === 0) {
      // 重复消息：只记一条审计，不做任何业务写入 —— 不重复记账
      ledger.append(db, 'ingest.duplicate', message_id, { source, event_type });
      return { status: 'duplicate' };
    }
    normalizer(db, payload, msg);
    const entry = ledger.append(db, 'ingest', message_id, { source, event_type, occurred_at });
    return { status: 'inserted', seq: entry.seq };
  });
}

/**
 * 来源回补：批量重放历史消息。靠同一套幂等逻辑，已存在的消息全部计为 duplicate。
 */
function backfill(db, messages, label = 'backfill') {
  let inserted = 0;
  let duplicates = 0;
  tx(db, () => {
    for (const m of messages) {
      const r = ingestOneInTx(db, m);
      if (r.status === 'inserted') inserted += 1;
      else duplicates += 1;
    }
    ledger.append(db, 'backfill', label, { total: messages.length, inserted, duplicates });
  });
  return { total: messages.length, inserted, duplicates };
}

// 事务内复用的单条摄入（避免嵌套事务）
function ingestOneInTx(db, msg) {
  const { source, message_id, event_type, payload, occurred_at } = msg;
  const normalizer = normalizers[event_type];
  if (!normalizer) throw new Error(`未知事件类型: ${event_type}`);
  const r = db
    .prepare(
      `INSERT INTO source_messages (source, message_id, event_type, payload, occurred_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source, message_id) DO NOTHING`
    )
    .run(source, message_id, event_type, JSON.stringify(payload), occurred_at, now());
  if (r.changes === 0) {
    ledger.append(db, 'ingest.duplicate', message_id, { source, event_type });
    return { status: 'duplicate' };
  }
  normalizer(db, payload, msg);
  ledger.append(db, 'ingest', message_id, { source, event_type, occurred_at });
  return { status: 'inserted' };
}

module.exports = { ingest, backfill, cents };
