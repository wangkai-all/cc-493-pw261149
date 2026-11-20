'use strict';
// 端到端验证：差异分类、跨月履约、重复消息幂等、来源回补不重复记账、
// 调整审批入账唯一、审计账本不可变。运行：npm run verify
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { ingest, backfill } = require('../src/ingest');
const recon = require('../src/reconcile');
const ledger = require('../src/ledger');
const { buildMessages, duplicateMessages, backfillMessages } = require('../src/seed');

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}
const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const sum = (db, table, col) => db.prepare(`SELECT COALESCE(SUM(${col}),0) v FROM ${table}`).get().v;
const resultOf = (db, runId, orderId) =>
  db.prepare(`SELECT * FROM recon_results WHERE run_id=? AND order_id=?`).get(runId, orderId);

console.log('收入确认对账工具 · 端到端验证\n');

const db = openDb(':memory:');

// ---------- 1. 摄入 ----------
console.log('【1】消息摄入');
const msgs = buildMessages();
for (const m of msgs) ingest(db, m);
ok('31 条基础消息全部摄入', () => {
  assert.equal(count(db, 'source_messages'), 31);
  assert.equal(count(db, 'orders'), 9);
  assert.equal(count(db, 'fulfillments'), 9);
  assert.equal(count(db, 'invoices'), 11);
  assert.equal(count(db, 'refunds'), 1);
  assert.equal(count(db, 'order_revisions'), 1);
});

// ---------- 2. 重复消息 ----------
console.log('【2】重复消息（中间件重复投递）');
ok('O-1001 消息重发全部判重，业务表零变化', () => {
  const before = {
    msg: count(db, 'source_messages'), ord: count(db, 'orders'),
    ful: count(db, 'fulfillments'), inv: count(db, 'invoices'),
    invSum: sum(db, 'invoices', 'amount'),
  };
  const results = duplicateMessages().map((m) => ingest(db, m));
  assert.ok(results.every((r) => r.status === 'duplicate'), '应全部判重');
  assert.equal(count(db, 'source_messages'), before.msg, '消息表不应增长');
  assert.equal(count(db, 'orders'), before.ord);
  assert.equal(count(db, 'fulfillments'), before.ful);
  assert.equal(count(db, 'invoices'), before.inv);
  assert.equal(sum(db, 'invoices', 'amount'), before.invSum, '发票金额不得重复累加');
});
ok('重复判重也写入审计（ingest.duplicate）', () => {
  const n = db.prepare(`SELECT COUNT(*) n FROM audit_ledger WHERE entry_type='ingest.duplicate'`).get().n;
  assert.equal(n, 3);
});

// ---------- 3. 10 月对账：分类正确性 ----------
console.log('【3】10 月对账：差异分类');
const oct = recon.runRecon(db, '2026-10', 'verify');
ok('9 个订单全部分类', () => assert.equal(oct.orders, 9));
const expectOct = {
  'O-1001': ['matched', 'net_zero'],
  'O-1002': ['explainable', 'partial_fulfillment'],      // 拆单：3000 履约 1800
  'O-1003': ['explainable', 'cross_period'],             // 跨期：10 月开票 11 月交付
  'O-1004': ['matched', 'red_flush_net'],                // 冲销闭环
  'O-1005': ['explainable', 'amount_revision'],          // 金额修订 1000→800
  'O-1006': ['conflict', 'unmatched_amount'],            // 真实冲突
  'O-1007': ['pending_data', 'invoice_missing'],         // 待补开票数据
  'O-1008': ['explainable', 'refund_pending_credit'],    // 退款待贷记
  'O-1009': ['explainable', 'red_flush_pending_reinvoice'], // 红冲待重开
};
for (const [oid, [cls, rule]] of Object.entries(expectOct)) {
  ok(`${oid} => ${cls}/${rule}`, () => {
    const r = resultOf(db, oct.run_id, oid);
    assert.equal(r.classification, cls, `分类不符: ${r.classification}`);
    assert.equal(r.rule, rule, `规则不符: ${r.rule}`);
  });
}
ok('O-1003 跨期差异金额 = 2000 元（票已开、货未发）', () => {
  const r = resultOf(db, oct.run_id, 'O-1003');
  assert.equal(r.recognized_amount, 0);
  assert.equal(r.invoiced_amount, 200000);
  assert.equal(r.diff, 200000);
});
ok('O-1005 修订差异金额 = 200 元（旧票 1000 − 新价 800）', () => {
  assert.equal(resultOf(db, oct.run_id, 'O-1005').diff, 20000);
});
ok('差异证据随结果落库（含履约/发票明细）', () => {
  const ev = JSON.parse(resultOf(db, oct.run_id, 'O-1002').evidence);
  assert.equal(ev.fulfillments.length, 1);
  assert.equal(ev.invoices.length, 1);
  assert.equal(ev.invoices[0].amount, 300000);
});

// ---------- 4. 确认冻结 ----------
console.log('【4】版本确认与冻结');
recon.confirmRun(db, oct.run_id, 'verify');
ok('确认后状态为 confirmed', () => {
  assert.equal(db.prepare(`SELECT status FROM recon_runs WHERE run_id=?`).get(oct.run_id).status, 'confirmed');
});
ok('重复确认被拒绝', () => {
  assert.throws(() => recon.confirmRun(db, oct.run_id, 'verify'), /不能重复确认/);
});

// ---------- 5. 来源回补 ----------
console.log('【5】来源回补（不重复记账）');
ok('回补批次：3 条历史判重 + 1 条迟到履约入账', () => {
  const before = { inv: sum(db, 'invoices', 'amount'), ful: count(db, 'fulfillments') };
  const r = backfill(db, backfillMessages(), 'verify-backfill');
  assert.equal(r.total, 4);
  assert.equal(r.duplicates, 3, '3 条历史消息应判重');
  assert.equal(r.inserted, 1, '仅迟到履约应入账');
  assert.equal(count(db, 'fulfillments'), before.ful + 1);
  assert.equal(sum(db, 'invoices', 'amount'), before.inv, '回补不得重复记发票');
});
ok('同一回补批次再跑一遍：全部判重，零入账', () => {
  const before = count(db, 'fulfillments');
  const r = backfill(db, backfillMessages(), 'verify-backfill-2');
  assert.equal(r.inserted, 0);
  assert.equal(r.duplicates, 4);
  assert.equal(count(db, 'fulfillments'), before);
});

// ---------- 6. 跨月验证 ----------
console.log('【6】跨月履约（10 月开票 → 11 月交付）');
const nov = recon.runRecon(db, '2026-11', 'verify');
ok('O-1003 收入在 11 月确认，差异归零', () => {
  const r = resultOf(db, nov.run_id, 'O-1003');
  assert.equal(r.classification, 'matched');
  assert.equal(r.recognized_amount, 200000, '收入应落在交付月 11 月');
  assert.equal(r.diff, 0);
});
ok('O-1002 回补履约后 11 月差异归零', () => {
  const r = resultOf(db, nov.run_id, 'O-1002');
  assert.equal(r.classification, 'matched');
  assert.equal(r.recognized_amount, 300000);
});
ok('10 月已确认快照不受 11 月数据影响（版本不可变）', () => {
  const r = resultOf(db, oct.run_id, 'O-1002');
  assert.equal(r.classification, 'explainable', '历史快照应保持 partial_fulfillment');
  assert.equal(r.recognized_amount, 180000, '历史快照金额不得被回填改写');
});

// ---------- 7. 调整审批 ----------
console.log('【7】调整审批与入账唯一性');
const r1005 = resultOf(db, nov.run_id, 'O-1005');
const adj = recon.createAdjustment(db, {
  result_id: r1005.id, side: 'invoiced', amount: -r1005.diff,
  reason: '金额修订 1000→800，红冲原票按新价重开', created_by: 'verify',
});
ok('调整单创建为待审批', () => assert.equal(adj.status, 'pending'));
recon.decideAdjustment(db, adj.adjustment_id, 'approved', 'cfo');
ok('审批通过生成唯一入账记录', () => {
  assert.equal(count(db, 'adjustment_entries'), 1);
  assert.equal(db.prepare(`SELECT status FROM adjustments WHERE adjustment_id=?`).get(adj.adjustment_id).status, 'approved');
});
ok('重复审批被拒绝，不会重复入账', () => {
  assert.throws(() => recon.decideAdjustment(db, adj.adjustment_id, 'approved', 'cfo'), /不能重复审批/);
  assert.equal(count(db, 'adjustment_entries'), 1);
});
ok('调整后重跑 11 月：O-1005 差异归零', () => {
  const nov2 = recon.runRecon(db, '2026-11', 'verify');
  const r = resultOf(db, nov2.run_id, 'O-1005');
  assert.equal(r.diff, 0);
  assert.equal(r.classification, 'matched');
  assert.equal(nov2.version, 2, '同一期间版本应递增');
});

// ---------- 8. 审计账本不可变 ----------
console.log('【8】审计账本不可变性');
ok('哈希链完整可验证', () => {
  const v = ledger.verifyChain(db);
  assert.equal(v.ok, true, v.reason);
  assert.ok(v.entries > 30, `审计条目应充足，实际 ${v.entries}`);
});
ok('UPDATE 被触发器拒绝', () => {
  assert.throws(() => db.prepare(`UPDATE audit_ledger SET payload='{}' WHERE seq=1`).run(), /append-only/);
});
ok('DELETE 被触发器拒绝', () => {
  assert.throws(() => db.prepare(`DELETE FROM audit_ledger WHERE seq=1`).run(), /append-only/);
});
ok('审批动作已写入审计链', () => {
  const n = db.prepare(`SELECT COUNT(*) n FROM audit_ledger WHERE entry_type='adjustment.approved'`).get().n;
  assert.equal(n, 1);
});

// ---------- 9. 全量重放幂等 ----------
console.log('【9】全量消息重放（灾难恢复场景）');
ok('31 条消息全部重放：零新增、金额不变', () => {
  const before = {
    msg: count(db, 'source_messages'),
    invSum: sum(db, 'invoices', 'amount'),
    fulSum: sum(db, 'fulfillments', 'amount'),
    refSum: sum(db, 'refunds', 'amount'),
  };
  const r = backfill(db, msgs, 'full-replay');
  assert.equal(r.inserted, 0);
  assert.equal(r.duplicates, 31);
  assert.equal(count(db, 'source_messages'), before.msg);
  assert.equal(sum(db, 'invoices', 'amount'), before.invSum);
  assert.equal(sum(db, 'fulfillments', 'amount'), before.fulSum);
  assert.equal(sum(db, 'refunds', 'amount'), before.refSum);
});

// ---------- 10. HTTP API 冒烟 ----------
console.log('【10】HTTP API 冒烟');
const { createApp } = require('../src/server');
const server = createApp(db);
const http = require('node:http');
function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ port, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    }).on('error', reject);
  });
}
server.listen(0, async () => {
  const port = server.address().port;
  try {
    const health = await get(port, '/api/health');
    assert.equal(health.status, 200);
    const verify = await get(port, '/api/audit/verify');
    assert.equal(verify.body.ok, true);
    const chain = await get(port, '/api/orders/O-1003/chain');
    assert.equal(chain.body.fulfillments.length, 1);
    assert.equal(chain.body.invoices.length, 1);
    const summary = await get(port, '/api/summary');
    assert.ok(summary.body.run_id);
    console.log('  ✓ /api/health、/api/audit/verify、/api/orders/:id/chain、/api/summary 正常');
    passed += 1;
  } catch (e) {
    console.error('  ✗ HTTP 冒烟失败:', e.message);
    process.exitCode = 1;
  } finally {
    server.close();
    console.log(`\n${process.exitCode ? '存在失败项' : `全部通过（${passed + 1} 项）`}`);
  }
});
