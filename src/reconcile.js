'use strict';
// 对账引擎：按期间（YYYY-MM）对全部订单做三链路核对 ——
//   履约确认收入(recognized) = 累计履约金额 - 累计退款 + 已生效调整(recognized 侧)
//   开票净额(invoiced)       = 累计发票(红冲为负) + 已生效调整(invoiced 侧)
//   差异 diff = invoiced - recognized
// 差异分类：matched(无差异) / explainable(可解释) / pending_data(待补数据) / conflict(真实冲突)
const { now, tx } = require('./db');
const ledger = require('./ledger');

const TOLERANCE = 0; // 分

function periodEnd(period) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)).toISOString(); // 该月最后一天
}

// 汇总某订单截至 period_end 的各链路金额与事实
function gatherFacts(db, orderId, endIso) {
  const q = (sql) => db.prepare(sql).get(orderId, endIso);
  const fulfilled = q(`SELECT COALESCE(SUM(amount),0) v FROM fulfillments WHERE order_id=? AND delivered_at<=?`).v;
  const refunded = q(`SELECT COALESCE(SUM(amount),0) v FROM refunds WHERE order_id=? AND refunded_at<=?`).v;
  const invoicedNet = q(`SELECT COALESCE(SUM(amount),0) v FROM invoices WHERE order_id=? AND issued_at<=?`).v;
  const adjRecognized = q(
    `SELECT COALESCE(SUM(amount),0) v FROM adjustment_entries WHERE order_id=? AND side='recognized' AND applied_at<=?`
  ).v;
  const adjInvoiced = q(
    `SELECT COALESCE(SUM(amount),0) v FROM adjustment_entries WHERE order_id=? AND side='invoiced' AND applied_at<=?`
  ).v;

  const fulfillments = db
    .prepare(`SELECT * FROM fulfillments WHERE order_id=? ORDER BY delivered_at`)
    .all(orderId);
  const futureFulfilled = fulfillments
    .filter((f) => f.delivered_at > endIso)
    .reduce((s, f) => s + f.amount, 0);
  const invoices = db.prepare(`SELECT * FROM invoices WHERE order_id=? AND issued_at<=? ORDER BY issued_at`).all(orderId, endIso);
  const refunds = db.prepare(`SELECT * FROM refunds WHERE order_id=? AND refunded_at<=? ORDER BY refunded_at`).all(orderId, endIso);
  const revisions = db.prepare(`SELECT * FROM order_revisions WHERE order_id=? AND revised_at<=? ORDER BY revised_at`).all(orderId, endIso);

  return {
    fulfilled,
    refunded,
    invoicedNet,
    adjRecognized,
    adjInvoiced,
    fulfillments,
    futureFulfilled,
    invoices,
    refunds,
    revisions,
    hasRedFlush: invoices.some((i) => i.kind === 'red_flush'),
  };
}

// 分类规则：按优先级依次尝试，命中即返回。每条规则返回 {classification, rule, explanation, evidence}
function classify(order, facts, endIso, period) {
  const recognized = facts.fulfilled - facts.refunded + facts.adjRecognized;
  const invoiced = facts.invoicedNet + facts.adjInvoiced;
  const diff = invoiced - recognized;
  const ev = {
    fulfillments: facts.fulfillments.map((f) => ({ id: f.fulfillment_id, amount: f.amount, delivered_at: f.delivered_at })),
    invoices: facts.invoices.map((i) => ({ id: i.invoice_id, amount: i.amount, kind: i.kind, issued_at: i.issued_at })),
    refunds: facts.refunds.map((r) => ({ id: r.refund_id, amount: r.amount, refunded_at: r.refunded_at })),
    revisions: facts.revisions.map((r) => ({ old: r.old_amount, new: r.new_amount, revised_at: r.revised_at })),
  };

  // ---- 0. 无差异 ----
  if (Math.abs(diff) <= TOLERANCE) {
    let rule = 'net_zero';
    let explanation = '开票净额与履约确认收入一致';
    if (facts.hasRedFlush) {
      rule = 'red_flush_net';
      explanation = '存在红冲发票，红冲后开票净额与履约确认收入一致（冲销已闭环）';
    }
    return { classification: 'matched', rule, explanation, evidence: ev, recognized, invoiced, diff };
  }

  // ---- 1. 待补数据：关键来源记录缺失，无法核对 ----
  if (recognized > 0 && facts.invoices.length === 0) {
    return {
      classification: 'pending_data',
      rule: 'invoice_missing',
      explanation: `已履约确认收入 ${recognized} 分，但未收到任何开票数据，待开票系统同步`,
      evidence: ev, recognized, invoiced, diff,
    };
  }
  if (facts.invoices.length > 0 && facts.fulfillments.length === 0) {
    return {
      classification: 'pending_data',
      rule: 'fulfillment_missing',
      explanation: `已开票 ${invoiced} 分，但无任何履约记录，待履约系统同步`,
      evidence: ev, recognized, invoiced, diff,
    };
  }
  if (facts.refunds.length > 0 && facts.fulfillments.length === 0) {
    return {
      classification: 'pending_data',
      rule: 'refund_unmatched',
      explanation: '存在退款但无履约记录，无法核对退款对应交付，待补履约数据',
      evidence: ev, recognized, invoiced, diff,
    };
  }

  // ---- 2. 可解释：命中已知业务规则且金额完全吻合 ----
  // 2a. 跨期履约：订单在本期及以前，部分/全部履约发生在本期之后（收入应下期确认）
  const remainder = order.current_amount - facts.fulfilled; // 尚未履约的金额
  if (facts.futureFulfilled > 0 && diff === remainder && facts.futureFulfilled === remainder) {
    const futureDates = facts.fulfillments.filter((f) => f.delivered_at > endIso).map((f) => f.delivered_at.slice(0, 10));
    return {
      classification: 'explainable',
      rule: 'cross_period',
      explanation: `跨期履约：${remainder} 分的履约发生在 ${period} 之后（${futureDates.join('、')}），收入将在履约所在期间确认，本期差异为时间性差异`,
      evidence: ev, recognized, invoiced, diff,
    };
  }
  // 2b. 拆单/部分履约：订单被拆成多笔履约，尚有未履约部分，发票已按全额开具
  if (facts.fulfillments.length >= 1 && remainder > 0 && facts.futureFulfilled === 0 && diff === remainder) {
    return {
      classification: 'explainable',
      rule: 'partial_fulfillment',
      explanation: `拆单部分履约：订单 ${order.current_amount} 分，已履约 ${facts.fulfilled} 分（${facts.fulfillments.length} 笔），剩余 ${remainder} 分待履约，发票已全额开具`,
      evidence: ev, recognized, invoiced, diff,
    };
  }
  // 2c. 金额修订：订单金额修订后，发票仍按旧金额开具
  if (facts.revisions.length > 0) {
    const last = facts.revisions[facts.revisions.length - 1];
    if (diff === last.old_amount - last.new_amount) {
      return {
        classification: 'explainable',
        rule: 'amount_revision',
        explanation: `金额修订：订单由 ${last.old_amount} 分修订为 ${last.new_amount} 分，发票仍按修订前金额开具，差异 ${diff} 分待红冲重开`,
        evidence: ev, recognized, invoiced, diff,
      };
    }
  }
  // 2d. 冲销后待重开：原发票被全额红冲，有效发票净额为 0，重开发票未同步
  if (facts.hasRedFlush && invoiced === 0 && recognized > 0) {
    const redFlushed = facts.invoices.filter((i) => i.kind === 'red_flush').reduce((s, i) => s - i.amount, 0); // 正数
    return {
      classification: 'explainable',
      rule: 'red_flush_pending_reinvoice',
      explanation: `发票 ${redFlushed} 分已全额红冲，重开发票未同步，收入 ${recognized} 分待新发票覆盖`,
      evidence: ev, recognized, invoiced, diff,
    };
  }

  // 2e. 退款待贷记：退款已冲减收入，发票侧尚未红冲/贷记对应金额
  if (facts.refunded > 0 && diff === facts.refunded) {
    return {
      classification: 'explainable',
      rule: 'refund_pending_credit',
      explanation: `退款 ${facts.refunded} 分已确认并冲减收入，发票侧待红冲/贷记相同金额`,
      evidence: ev, recognized, invoiced, diff,
    };
  }

  // ---- 3. 真实冲突：无任何规则能解释 ----
  return {
    classification: 'conflict',
    rule: 'unmatched_amount',
    explanation: `开票净额 ${invoiced} 分与履约确认收入 ${recognized} 分相差 ${diff} 分，无拆单/跨期/冲销/修订记录可解释`,
    evidence: ev, recognized, invoiced, diff,
  };
}

// 执行一次对账，生成新版本结果
function runRecon(db, period, triggeredBy = 'system') {
  const endIso = periodEnd(period);
  return tx(db, () => {
    const { v: maxVer } = db.prepare(`SELECT COALESCE(MAX(version),0) v FROM recon_runs WHERE period=?`).get(period);
    const version = maxVer + 1;
    const runInfo = db
      .prepare(`INSERT INTO recon_runs (period, version, status, triggered_by, created_at) VALUES (?,?, 'open', ?, ?)`)
      .run(period, version, triggeredBy, now());
    const runId = Number(runInfo.lastInsertRowid);

    const orders = db.prepare(`SELECT * FROM orders WHERE created_at<=? ORDER BY order_id`).all(endIso);
    const ins = db.prepare(
      `INSERT INTO recon_results
        (run_id, order_id, order_amount, recognized_amount, invoiced_amount, refunded_amount, diff, classification, rule, explanation, evidence)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    const counts = { matched: 0, explainable: 0, pending_data: 0, conflict: 0 };
    for (const order of orders) {
      const facts = gatherFacts(db, order.order_id, endIso);
      const r = classify(order, facts, endIso, period);
      counts[r.classification] += 1;
      ins.run(
        runId, order.order_id, order.current_amount, r.recognized, r.invoiced, facts.refunded,
        r.diff, r.classification, r.rule, r.explanation, JSON.stringify(r.evidence)
      );
    }
    ledger.append(db, 'recon.run', String(runId), { period, version, orders: orders.length, ...counts });
    return { run_id: runId, period, version, orders: orders.length, counts };
  });
}

// 确认运行：结果冻结为不可变版本
function confirmRun(db, runId, actor = 'system') {
  return tx(db, () => {
    const run = db.prepare(`SELECT * FROM recon_runs WHERE run_id=?`).get(runId);
    if (!run) throw new Error(`运行不存在: ${runId}`);
    if (run.status !== 'open') throw new Error(`运行 ${runId} 已是 ${run.status}，不能重复确认`);
    db.prepare(`UPDATE recon_runs SET status='confirmed', confirmed_at=? WHERE run_id=?`).run(now(), runId);
    ledger.append(db, 'recon.confirm', String(runId), { period: run.period, version: run.version, actor });
    return { run_id: runId, status: 'confirmed' };
  });
}

// 创建调整（针对某条对账结果）
function createAdjustment(db, { result_id, side, amount, reason, created_by }) {
  const result = db.prepare(`SELECT * FROM recon_results WHERE id=?`).get(result_id);
  if (!result) throw new Error(`对账结果不存在: ${result_id}`);
  if (!['recognized', 'invoiced'].includes(side)) throw new Error('side 必须是 recognized 或 invoiced');
  if (!Number.isInteger(amount) || amount === 0) throw new Error('调整金额必须为非零整数（分）');
  return tx(db, () => {
    const info = db
      .prepare(
        `INSERT INTO adjustments (result_id, order_id, side, amount, reason, status, created_by, created_at)
         VALUES (?,?,?,?,?, 'pending', ?, ?)`
      )
      .run(result_id, result.order_id, side, amount, reason || '', created_by || 'system', now());
    return { adjustment_id: Number(info.lastInsertRowid), status: 'pending' };
  });
}

// 审批调整：通过则生成记账效果（adjustment_entries，adjustment_id 唯一 => 不会重复入账）+ 不可变审计
function decideAdjustment(db, adjustmentId, decision, actor = 'system') {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('decision 必须是 approved 或 rejected');
  return tx(db, () => {
    const adj = db.prepare(`SELECT * FROM adjustments WHERE adjustment_id=?`).get(adjustmentId);
    if (!adj) throw new Error(`调整不存在: ${adjustmentId}`);
    if (adj.status !== 'pending') throw new Error(`调整 ${adjustmentId} 已是 ${adj.status}，不能重复审批`);
    db.prepare(`UPDATE adjustments SET status=?, decided_by=?, decided_at=? WHERE adjustment_id=?`).run(
      decision, actor, now(), adjustmentId
    );
    if (decision === 'approved') {
      db.prepare(
        `INSERT INTO adjustment_entries (adjustment_id, order_id, side, amount, applied_at)
         VALUES (?,?,?,?,?) ON CONFLICT(adjustment_id) DO NOTHING`
      ).run(adjustmentId, adj.order_id, adj.side, adj.amount, now());
    }
    ledger.append(db, `adjustment.${decision}`, String(adjustmentId), {
      order_id: adj.order_id, side: adj.side, amount: adj.amount, reason: adj.reason, actor,
    });
    return { adjustment_id: adjustmentId, status: decision };
  });
}

// 对账链路：一个订单的完整资金链路
function getChain(db, orderId) {
  const order = db.prepare(`SELECT * FROM orders WHERE order_id=?`).get(orderId);
  if (!order) return null;
  const revisions = db.prepare(`SELECT * FROM order_revisions WHERE order_id=? ORDER BY revised_at`).all(orderId);
  const fulfillments = db.prepare(`SELECT * FROM fulfillments WHERE order_id=? ORDER BY delivered_at`).all(orderId);
  const invoices = db.prepare(`SELECT * FROM invoices WHERE order_id=? ORDER BY issued_at`).all(orderId);
  const refunds = db.prepare(`SELECT * FROM refunds WHERE order_id=? ORDER BY refunded_at`).all(orderId);
  const adjustments = db
    .prepare(`SELECT * FROM adjustments WHERE order_id=? ORDER BY created_at`).all(orderId);
  const latest = db
    .prepare(
      `SELECT r.*, ru.period, ru.version, ru.status AS run_status FROM recon_results r
       JOIN recon_runs ru ON ru.run_id = r.run_id
       WHERE r.order_id=? ORDER BY r.run_id DESC LIMIT 1`
    )
    .get(orderId);
  return { order, revisions, fulfillments, invoices, refunds, adjustments, latest_result: latest || null };
}

module.exports = { runRecon, confirmRun, createAdjustment, decideAdjustment, getChain, periodEnd, gatherFacts, classify };
