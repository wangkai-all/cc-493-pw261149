'use strict';
// 演示数据：覆盖 正常/拆单/跨期履约/冲销/金额修订/退款/待补数据/真实冲突 全场景。
// 时间线：2026-10 为上期，2026-11 为本期（跨月验证）。
const { ingest, backfill } = require('./ingest');
const { runRecon, confirmRun, createAdjustment } = require('./reconcile');

const M = (source, message_id, event_type, occurred_at, payload) => ({
  source, message_id, event_type, occurred_at, payload,
});

// 基础消息流（金额单位：元，摄入层转分）
function buildMessages() {
  return [
    // O-1001 正常订单：履约、开票一致 -> matched
    M('order', 'msg-o1001-created', 'order.created', '2026-10-05T09:00:00Z', { order_id: 'O-1001', amount: 1000.0 }),
    M('fulfillment', 'msg-o1001-ful', 'fulfillment.delivered', '2026-10-08T10:00:00Z', { fulfillment_id: 'F-1001-1', order_id: 'O-1001', line_id: 'L1', qty: 10, amount: 1000.0 }),
    M('invoice', 'msg-o1001-inv', 'invoice.issued', '2026-10-09T09:00:00Z', { invoice_id: 'INV-1001', order_id: 'O-1001', amount: 1000.0 }),

    // O-1002 拆单：¥3000 拆两笔履约，10 月只到 ¥1800，发票已全额开 -> partial_fulfillment（可解释）
    M('order', 'msg-o1002-created', 'order.created', '2026-10-06T09:00:00Z', { order_id: 'O-1002', amount: 3000.0 }),
    M('fulfillment', 'msg-o1002-ful1', 'fulfillment.delivered', '2026-10-10T10:00:00Z', { fulfillment_id: 'F-1002-1', order_id: 'O-1002', line_id: 'L1', qty: 6, amount: 1800.0 }),
    M('invoice', 'msg-o1002-inv', 'invoice.issued', '2026-10-11T09:00:00Z', { invoice_id: 'INV-1002', order_id: 'O-1002', amount: 3000.0 }),

    // O-1003 跨期履约：10 月下单并开票，11 月才交付 -> 10 月 cross_period（可解释），11 月 matched
    M('order', 'msg-o1003-created', 'order.created', '2026-10-28T09:00:00Z', { order_id: 'O-1003', amount: 2000.0 }),
    M('invoice', 'msg-o1003-inv', 'invoice.issued', '2026-10-30T09:00:00Z', { invoice_id: 'INV-1003', order_id: 'O-1003', amount: 2000.0 }),
    M('fulfillment', 'msg-o1003-ful', 'fulfillment.delivered', '2026-11-03T10:00:00Z', { fulfillment_id: 'F-1003-1', order_id: 'O-1003', line_id: 'L1', qty: 4, amount: 2000.0 }),

    // O-1004 冲销闭环：发票开错 ¥900，红冲后重开 ¥800 -> matched（red_flush_net）
    M('order', 'msg-o1004-created', 'order.created', '2026-10-07T09:00:00Z', { order_id: 'O-1004', amount: 800.0 }),
    M('fulfillment', 'msg-o1004-ful', 'fulfillment.delivered', '2026-10-08T10:00:00Z', { fulfillment_id: 'F-1004-1', order_id: 'O-1004', line_id: 'L1', qty: 8, amount: 800.0 }),
    M('invoice', 'msg-o1004-inv-wrong', 'invoice.issued', '2026-10-09T09:00:00Z', { invoice_id: 'INV-1004-A', order_id: 'O-1004', amount: 900.0 }),
    M('invoice', 'msg-o1004-redflush', 'invoice.red_flushed', '2026-10-10T09:00:00Z', { invoice_id: 'INV-1004-R', order_id: 'O-1004', amount: 900.0, red_flush_of: 'INV-1004-A' }),
    M('invoice', 'msg-o1004-inv-right', 'invoice.issued', '2026-10-10T10:00:00Z', { invoice_id: 'INV-1004-B', order_id: 'O-1004', amount: 800.0 }),

    // O-1005 金额修订：开票 ¥1000 后订单修订为 ¥800，履约按新价 -> amount_revision（可解释，差异 200）
    M('order', 'msg-o1005-created', 'order.created', '2026-10-12T09:00:00Z', { order_id: 'O-1005', amount: 1000.0 }),
    M('invoice', 'msg-o1005-inv', 'invoice.issued', '2026-10-13T09:00:00Z', { invoice_id: 'INV-1005', order_id: 'O-1005', amount: 1000.0 }),
    M('order', 'msg-o1005-revised', 'order.amount_revised', '2026-10-14T09:00:00Z', { order_id: 'O-1005', new_amount: 800.0 }),
    M('fulfillment', 'msg-o1005-ful', 'fulfillment.delivered', '2026-10-15T10:00:00Z', { fulfillment_id: 'F-1005-1', order_id: 'O-1005', line_id: 'L1', qty: 8, amount: 800.0 }),

    // O-1006 真实冲突：履约 ¥1500，发票 ¥1750，无任何解释 -> conflict
    M('order', 'msg-o1006-created', 'order.created', '2026-10-15T09:00:00Z', { order_id: 'O-1006', amount: 1500.0 }),
    M('fulfillment', 'msg-o1006-ful', 'fulfillment.delivered', '2026-10-16T10:00:00Z', { fulfillment_id: 'F-1006-1', order_id: 'O-1006', line_id: 'L1', qty: 15, amount: 1500.0 }),
    M('invoice', 'msg-o1006-inv', 'invoice.issued', '2026-10-17T09:00:00Z', { invoice_id: 'INV-1006', order_id: 'O-1006', amount: 1750.0 }),

    // O-1007 待补数据：已履约，开票数据未同步 -> pending_data
    M('order', 'msg-o1007-created', 'order.created', '2026-10-18T09:00:00Z', { order_id: 'O-1007', amount: 600.0 }),
    M('fulfillment', 'msg-o1007-ful', 'fulfillment.delivered', '2026-10-19T10:00:00Z', { fulfillment_id: 'F-1007-1', order_id: 'O-1007', line_id: 'L1', qty: 6, amount: 600.0 }),

    // O-1008 退款：履约开票一致后退款 ¥200，发票待贷记 -> refund_pending_credit（可解释）
    M('order', 'msg-o1008-created', 'order.created', '2026-10-20T09:00:00Z', { order_id: 'O-1008', amount: 1200.0 }),
    M('fulfillment', 'msg-o1008-ful', 'fulfillment.delivered', '2026-10-21T10:00:00Z', { fulfillment_id: 'F-1008-1', order_id: 'O-1008', line_id: 'L1', qty: 12, amount: 1200.0 }),
    M('invoice', 'msg-o1008-inv', 'invoice.issued', '2026-10-22T09:00:00Z', { invoice_id: 'INV-1008', order_id: 'O-1008', amount: 1200.0 }),
    M('refund', 'msg-o1008-refund', 'refund.completed', '2026-10-25T09:00:00Z', { refund_id: 'R-1008-1', order_id: 'O-1008', amount: 200.0, reason: '部分退货' }),

    // O-1009 冲销待重开：发票全额红冲，新票未开 -> red_flush_pending_reinvoice（可解释）
    M('order', 'msg-o1009-created', 'order.created', '2026-10-26T09:00:00Z', { order_id: 'O-1009', amount: 700.0 }),
    M('fulfillment', 'msg-o1009-ful', 'fulfillment.delivered', '2026-10-27T10:00:00Z', { fulfillment_id: 'F-1009-1', order_id: 'O-1009', line_id: 'L1', qty: 7, amount: 700.0 }),
    M('invoice', 'msg-o1009-inv', 'invoice.issued', '2026-10-28T09:00:00Z', { invoice_id: 'INV-1009-A', order_id: 'O-1009', amount: 700.0 }),
    M('invoice', 'msg-o1009-redflush', 'invoice.red_flushed', '2026-10-29T09:00:00Z', { invoice_id: 'INV-1009-R', order_id: 'O-1009', amount: 700.0, red_flush_of: 'INV-1009-A' }),
  ];
}

// 重复消息（模拟消息中间件重复投递）：O-1001 全部消息重发一遍
function duplicateMessages() {
  return buildMessages().filter((m) => m.message_id.startsWith('msg-o1001'));
}

// 来源回补批次：重放历史 + 一条迟到的 O-1002 第二笔履约（11 月到货）
function backfillMessages() {
  const replay = buildMessages().filter((m) => m.message_id.startsWith('msg-o1002'));
  const late = M('fulfillment', 'msg-o1002-ful2', 'fulfillment.delivered', '2026-11-02T10:00:00Z', {
    fulfillment_id: 'F-1002-2', order_id: 'O-1002', line_id: 'L2', qty: 4, amount: 1200.0,
  });
  return [...replay, late];
}

// 播种：摄入 -> 10 月对账并确认 -> 重复消息 -> 回补 -> 11 月对账 -> 生成一条待审批调整
function seed(db) {
  const log = [];
  const base = buildMessages();
  for (const m of base) ingest(db, m);
  log.push(`摄入基础消息 ${base.length} 条`);

  const oct = runRecon(db, '2026-10', 'seed');
  confirmRun(db, oct.run_id, 'seed');
  log.push(`10 月对账完成并确认 (run=${oct.run_id}): ${JSON.stringify(oct.counts)}`);

  // 重复消息：应全部判重，不影响任何金额
  let dup = 0;
  for (const m of duplicateMessages()) {
    if (ingest(db, m).status === 'duplicate') dup += 1;
  }
  log.push(`重复消息 ${dup} 条全部判重跳过`);

  // 来源回补：3 条重复 + 1 条迟到履约，不会重复记账
  const bf = backfill(db, backfillMessages(), 'oct-backfill-01');
  log.push(`来源回补: 共 ${bf.total} 条, 新增 ${bf.inserted}, 判重 ${bf.duplicates}`);

  const nov = runRecon(db, '2026-11', 'seed');
  log.push(`11 月对账完成 (run=${nov.run_id}): ${JSON.stringify(nov.counts)}`);

  // 针对 O-1005 的金额修订差异，生成一条待审批调整（红冲重开：invoiced 侧 -200）
  const r1005 = db
    .prepare(`SELECT * FROM recon_results WHERE run_id=? AND order_id='O-1005'`)
    .get(nov.run_id);
  if (r1005 && r1005.diff !== 0) {
    createAdjustment(db, {
      result_id: r1005.id,
      side: 'invoiced',
      amount: -r1005.diff,
      reason: '订单金额修订 ¥1000→¥800，红冲原票按新金额重开',
      created_by: 'seed',
    });
    log.push(`已创建 O-1005 调整单（待审批）`);
  }
  return log;
}

if (require.main === module) {
  const { openDb } = require('./db');
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(__dirname, '..', 'data', 'recon.db');
  fs.rmSync(file, { force: true });
  fs.rmSync(file + '-wal', { force: true });
  fs.rmSync(file + '-shm', { force: true });
  const db = openDb(file);
  const log = seed(db);
  for (const line of log) console.log('•', line);
  console.log('✔ 演示数据已写入', file);
}

module.exports = { seed, buildMessages, duplicateMessages, backfillMessages };
