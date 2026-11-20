'use strict';
/* 收入确认对账工具 - 前端逻辑（无框架，fetch 直连 API） */

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

const fmt = (cents) =>
  (cents / 100).toLocaleString('zh-CN', { style: 'currency', currency: 'CNY' });
const fmtSigned = (cents) => (cents > 0 ? '+' : '') + fmt(cents);
const fmtTime = (iso) => (iso ? iso.replace('T', ' ').slice(0, 16) : '—');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CLASS = {
  matched: { label: '无差异', icon: '✓', color: 'var(--good)', darkText: false },
  explainable: { label: '可解释', icon: 'ⓘ', color: 'var(--series-1)', darkText: false },
  pending_data: { label: '待补数据', icon: '⏳', color: 'var(--warning)', darkText: true },
  conflict: { label: '真实冲突', icon: '✕', color: 'var(--critical)', darkText: false },
};
const badge = (cls) => {
  const m = CLASS[cls] || { label: cls, icon: '?' };
  return `<span class="badge ${cls}"><span aria-hidden="true">${m.icon}</span>${m.label}</span>`;
};

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.hidden = true), ms);
}

/* ================= 路由 ================= */
const pages = ['overview', 'chain', 'diffs', 'approvals', 'runs'];
const loaders = {};
function go(page) {
  if (!pages.includes(page)) page = 'overview';
  $$('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.page === page)));
  pages.forEach((p) => ($(`#page-${p}`).hidden = p !== page));
  location.hash = page;
  loaders[page]?.();
}
$$('.tab').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));

/* ================= 总览 ================= */
loaders.overview = async () => {
  const [summary, audit] = await Promise.all([api('/api/summary'), api('/api/audit?limit=8')]);
  // Hero：真实冲突数
  const byClass = Object.fromEntries((summary.by_class || []).map((r) => [r.classification, r]));
  const conflictN = byClass.conflict?.n || 0;
  $('#heroConflict').textContent = conflictN;
  $('#heroConflict').classList.toggle('has-conflict', conflictN > 0);
  $('#heroConflictSub').textContent = summary.run_id
    ? `最近运行 #${summary.run_id}（${summary.run.period} v${summary.run.version}，${summary.run.status === 'confirmed' ? '已确认' : '待确认'}）`
    : '尚未执行对账';

  // 指标瓦片
  const t = summary.totals || {};
  const tiles = [
    { label: '对账订单', value: (summary.by_class || []).reduce((s, r) => s + r.n, 0), sub: '最近运行覆盖' },
    { label: '确认收入', value: fmt(t.recognized || 0), sub: '履约口径，已扣退款' },
    { label: '开票净额', value: fmt(t.invoiced || 0), sub: '红冲抵减后' },
    { label: '退款合计', value: fmt(t.refunded || 0), sub: '截至期末' },
    { label: '待审批调整', value: summary.pending_adjustments ?? 0, sub: '等待财务审批' },
  ];
  $('#tiles').innerHTML = tiles
    .map((x) => `<div class="tile"><div class="tile-label">${x.label}</div><div class="tile-value">${x.value}</div><div class="tile-sub">${x.sub}</div></div>`)
    .join('');

  // 分类分布：高分段条形图（一个整体拆成部分）+ 图例 + 表格视图
  const order = ['matched', 'explainable', 'pending_data', 'conflict'];
  const total = order.reduce((s, k) => s + (byClass[k]?.n || 0), 0);
  $('#distRunLabel').textContent = summary.run_id ? `运行 #${summary.run_id} · ${summary.run.period}` : '';
  $('#segbar').innerHTML = total
    ? order
        .filter((k) => byClass[k]?.n > 0)
        .map((k) => {
          const n = byClass[k].n;
          const pct = ((n / total) * 100).toFixed(1);
          const m = CLASS[k];
          const label = `${n} 笔 · ${pct}%`;
          return `<div class="seg ${m.darkText ? 'dark-text' : ''}" style="width:${pct}%;background:${m.color}"
            title="${m.label} ${label}" tabindex="0" aria-label="${m.label} ${label}">${n / total >= 0.12 ? label : ''}</div>`;
        })
        .join('')
    : '<div class="empty">暂无数据</div>';
  $('#seglegend').innerHTML = order
    .map((k) => `<span class="item"><span class="swatch" style="background:${CLASS[k].color}"></span>${CLASS[k].icon} ${CLASS[k].label}</span>`)
    .join('');
  $('#distTable tbody').innerHTML = order
    .map((k) => {
      const r = byClass[k];
      return `<tr><td>${badge(k)}</td><td class="num">${r?.n || 0}</td><td class="num">${fmt(r?.abs_diff || 0)}</td></tr>`;
    })
    .join('');

  // 审计流水
  $('#auditTable tbody').innerHTML = audit.entries
    .map(
      (e) => `<tr><td class="num">${e.seq}</td><td>${esc(e.entry_type)}</td><td class="mono">${esc(e.ref_id)}</td>
      <td>${fmtTime(e.created_at)}</td><td class="hash" title="${e.hash}">${e.hash.slice(0, 12)}…</td></tr>`
    )
    .join('');
};

/* ================= 对账链路 ================= */
let chainOrders = [];
loaders.chain = async () => {
  if (!chainOrders.length) {
    const { orders } = await api('/api/orders');
    chainOrders = orders;
    $('#chainOrderSelect').innerHTML = orders.map((o) => `<option value="${esc(o.order_id)}">${esc(o.order_id)}（${fmt(o.current_amount)}）</option>`).join('');
  }
  await renderChain($('#chainOrderSelect').value || chainOrders[0]?.order_id);
};
$('#chainOrderSelect').addEventListener('change', (e) => renderChain(e.target.value));

async function renderChain(orderId) {
  if (!orderId) return;
  const c = await api(`/api/orders/${encodeURIComponent(orderId)}/chain`);
  // 汇总事件流：订单 -> 修订 -> 履约 -> 开票/红冲 -> 退款 -> 调整
  const events = [
    { t: c.order.created_at, kind: 'order', title: '订单创建', amount: c.order.current_amount, dot: '', body: `当前金额 ${fmt(c.order.current_amount)} · 状态 ${c.order.status}` },
    ...c.revisions.map((r) => ({ t: r.revised_at, kind: 'revision', title: '金额修订', amount: r.new_amount - r.old_amount, dot: 'amber', body: `${fmt(r.old_amount)} → ${fmt(r.new_amount)}` })),
    ...c.fulfillments.map((f) => ({ t: f.delivered_at, kind: 'fulfillment', title: `履约交付 ${f.fulfillment_id}`, amount: f.amount, dot: 'green', body: `行 ${f.line_id} · 数量 ${f.qty} · 确认收入 ${fmt(f.amount)}` })),
    ...c.invoices.map((i) => ({
      t: i.issued_at, kind: 'invoice',
      title: i.kind === 'red_flush' ? `红冲发票 ${i.invoice_id}` : `开具发票 ${i.invoice_id}`,
      amount: i.amount, dot: i.kind === 'red_flush' ? 'red' : '',
      body: i.kind === 'red_flush' ? `冲销 ${i.red_flush_of} · ${fmt(i.amount)}` : `开票 ${fmt(i.amount)}`,
    })),
    ...c.refunds.map((r) => ({ t: r.refunded_at, kind: 'refund', title: `退款 ${r.refund_id}`, amount: -r.amount, dot: 'red', body: `${fmt(r.amount)}${r.reason ? ' · ' + esc(r.reason) : ''}` })),
    ...c.adjustments.map((a) => ({
      t: a.created_at, kind: 'adjustment', title: `调整单 #${a.adjustment_id}（${a.side === 'invoiced' ? '开票侧' : '收入侧'}）`,
      amount: a.amount, dot: a.status === 'approved' ? 'green' : a.status === 'rejected' ? 'red' : 'amber',
      body: `${fmtSigned(a.amount)} · ${esc(a.reason)} · ${a.status === 'pending' ? '待审批' : a.status === 'approved' ? '已生效' : '已驳回'}`,
    })),
  ].sort((a, b) => a.t.localeCompare(b.t));

  $('#chainTimeline').innerHTML = events
    .map(
      (e) => `<div class="chain-node"><span class="dot ${e.dot}"></span>
      <div class="node-head"><span class="node-title">${esc(e.title)}</span>
      <span class="node-amount">${e.amount != null ? fmtSigned(e.amount) : ''}</span>
      <span class="node-time">${fmtTime(e.t)}</span></div>
      <div class="node-body">${e.body}</div></div>`
    )
    .join('');

  const r = c.latest_result;
  $('#chainSide').innerHTML = `
    <h3>三链路汇总${r ? `（${r.period} v${r.version}）` : ''}</h3>
    <dl>
      <dt>订单金额</dt><dd>${fmt(c.order.current_amount)}</dd>
      <dt>确认收入</dt><dd>${r ? fmt(r.recognized_amount) : '—'}</dd>
      <dt>开票净额</dt><dd>${r ? fmt(r.invoiced_amount) : '—'}</dd>
      <dt>退款</dt><dd>${r ? fmt(r.refunded_amount) : '—'}</dd>
      <div class="divider"></div>
      <dt>差异（票−收）</dt><dd><strong>${r ? fmtSigned(r.diff) : '—'}</strong></dd>
      <dt>分类</dt><dd>${r ? badge(r.classification) : '—'}</dd>
    </dl>
    ${r ? `<p class="card-sub" style="margin-top:10px">${esc(r.explanation || '')}</p>` : '<p class="card-sub">该订单尚未纳入对账运行</p>'}`;
}

/* ================= 差异证据 ================= */
let diffState = { runId: null, filter: 'all', results: [] };
loaders.diffs = async () => {
  const { runs } = await api('/api/recon/runs');
  if (!runs.length) {
    $('#diffList').innerHTML = '<div class="empty">尚未执行对账，请先到「版本结果」页运行</div>';
    return;
  }
  diffState.runId = diffState.runId || runs[0].run_id;
  $('#diffRunSelect').innerHTML = runs
    .map((r) => `<option value="${r.run_id}" ${r.run_id === diffState.runId ? 'selected' : ''}>#${r.run_id} · ${r.period} v${r.version} · ${r.status === 'confirmed' ? '已确认' : '待确认'}</option>`)
    .join('');
  const { results } = await api(`/api/recon/runs/${diffState.runId}/results`);
  diffState.results = results;
  renderDiffChips();
  renderDiffList();
};
$('#diffRunSelect').addEventListener('change', async (e) => {
  diffState.runId = Number(e.target.value);
  const { results } = await api(`/api/recon/runs/${diffState.runId}/results`);
  diffState.results = results;
  renderDiffChips();
  renderDiffList();
});

function renderDiffChips() {
  const counts = { all: diffState.results.length };
  for (const r of diffState.results) counts[r.classification] = (counts[r.classification] || 0) + 1;
  const defs = [['all', '全部'], ...Object.entries(CLASS).map(([k, v]) => [k, v.label])];
  $('#diffChips').innerHTML = defs
    .map(([k, label]) => `<button class="chip ${diffState.filter === k ? 'active' : ''}" data-f="${k}">${label} ${counts[k] || 0}</button>`)
    .join('');
  $$('#diffChips .chip').forEach((b) =>
    b.addEventListener('click', () => {
      diffState.filter = b.dataset.f;
      renderDiffChips();
      renderDiffList();
    })
  );
}

function evList(title, rows, render) {
  if (!rows?.length) return '';
  return `<div class="ev-box"><h4>${title}</h4><ul>${rows.map(render).join('')}</ul></div>`;
}

function renderDiffList() {
  const rows = diffState.results.filter((r) => diffState.filter === 'all' || r.classification === diffState.filter);
  if (!rows.length) {
    $('#diffList').innerHTML = '<div class="empty">该分类下没有记录</div>';
    return;
  }
  $('#diffList').innerHTML = rows
    .map((r) => {
      const ev = r.evidence;
      return `<div class="diff-item" data-id="${r.id}">
      <div class="diff-head">
        <span class="oid">${esc(r.order_id)}</span>
        ${badge(r.classification)}
        <span class="expl">${esc(r.explanation || '')}</span>
        <span class="amount">${fmtSigned(r.diff)}</span>
        ${r.classification !== 'matched' ? `<button class="btn sm" data-act="adj" data-id="${r.id}">发起调整</button>` : ''}
      </div>
      <div class="diff-body">
        <div class="evidence-grid">
          ${evList('履约记录', ev.fulfillments, (f) => `<li>${esc(f.id)} · ${fmt(f.amount)} · ${fmtTime(f.delivered_at)}</li>`)}
          ${evList('发票（含红冲）', ev.invoices, (i) => `<li>${esc(i.id)} · ${fmt(i.amount)} · ${i.kind === 'red_flush' ? '红冲' : '正常'} · ${fmtTime(i.issued_at)}</li>`)}
          ${evList('退款', ev.refunds, (x) => `<li>${esc(x.id)} · ${fmt(x.amount)} · ${fmtTime(x.refunded_at)}</li>`)}
          ${evList('金额修订', ev.revisions, (x) => `<li>${fmt(x.old)} → ${fmt(x.new)} · ${fmtTime(x.revised_at)}</li>`)}
        </div>
        <div class="mono">规则 ${esc(r.rule || '—')} · 确认收入 ${fmt(r.recognized_amount)} · 开票净额 ${fmt(r.invoiced_amount)} · 退款 ${fmt(r.refunded_amount)}</div>
      </div>
    </div>`;
    })
    .join('');

  $$('#diffList .diff-head').forEach((h) =>
    h.addEventListener('click', (e) => {
      if (e.target.dataset.act === 'adj') return;
      h.parentElement.classList.toggle('open');
    })
  );
  $$('#diffList [data-act="adj"]').forEach((b) =>
    b.addEventListener('click', () => openAdjDialog(diffState.results.find((r) => r.id === Number(b.dataset.id))))
  );
}

/* ================= 调整 ================= */
let adjTarget = null;
function openAdjDialog(result) {
  adjTarget = result;
  $('#adjDialogSub').textContent = `订单 ${result.order_id} · 差异 ${fmtSigned(result.diff)}（开票−收入）· ${result.explanation || ''}`;
  $('#adjAmount').value = (-result.diff / 100).toFixed(2);
  $('#adjReason').value = '';
  $('#adjDialog').showModal();
}
$('#adjForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.submitter && e.submitter.value === 'cancel') {
    $('#adjDialog').close();
    return;
  }
  if (!adjTarget) return;
  try {
    await api('/api/adjustments', {
      method: 'POST',
      body: {
        result_id: adjTarget.id,
        side: $('#adjSide').value,
        amount: Math.round(Number($('#adjAmount').value) * 100),
        reason: $('#adjReason').value,
        created_by: 'finance-ui',
      },
    });
    $('#adjDialog').close();
    toast('调整单已提交，等待审批');
    loaders.approvals();
  } catch (err) {
    toast('提交失败：' + err.message);
  }
});

/* ================= 调整审批 ================= */
loaders.approvals = async () => {
  const [{ adjustments: pending }, { adjustments: all }] = await Promise.all([
    api('/api/adjustments?status=pending'),
    api('/api/adjustments'),
  ]);
  $('#pendingCount').textContent = `${pending.length} 笔待处理`;
  $('#pendingList').innerHTML = pending.length
    ? pending
        .map(
          (a) => `<div class="adj-card">
        <div class="info">
          <div><strong>#${a.adjustment_id}</strong> · 订单 ${esc(a.order_id)} · ${a.side === 'invoiced' ? '开票侧' : '收入侧'}
            <strong>${fmtSigned(a.amount)}</strong> ${badge(a.classification)}</div>
          <div class="reason">${esc(a.reason)} · 差异 ${fmtSigned(a.result_diff)} · 由 ${esc(a.created_by)} 提交于 ${fmtTime(a.created_at)}</div>
        </div>
        <div class="adj-actions">
          <button class="btn primary sm" data-decide="approved" data-id="${a.adjustment_id}">通过并生效</button>
          <button class="btn danger sm" data-decide="rejected" data-id="${a.adjustment_id}">驳回</button>
        </div>
      </div>`
        )
        .join('')
    : '<div class="empty">没有待审批的调整</div>';
  $$('#pendingList [data-decide]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api(`/api/adjustments/${b.dataset.id}/decide`, {
          method: 'POST',
          body: { decision: b.dataset.decide, actor: 'finance-ui' },
        });
        toast(b.dataset.decide === 'approved' ? '已通过并写入审计账本' : '已驳回');
        loaders.approvals();
      } catch (err) {
        toast('操作失败：' + err.message);
      }
    })
  );
  $('#adjHistoryTable tbody').innerHTML = all
    .filter((a) => a.status !== 'pending')
    .map(
      (a) => `<tr><td>#${a.adjustment_id}</td><td>${esc(a.order_id)}</td><td>${a.side === 'invoiced' ? '开票侧' : '收入侧'}</td>
      <td class="num">${fmtSigned(a.amount)}</td><td>${esc(a.reason)}</td>
      <td><span class="badge ${a.status === 'approved' ? 'matched' : 'conflict'}">${a.status === 'approved' ? '✓ 已生效' : '✕ 已驳回'}</span></td>
      <td>${esc(a.decided_by || '—')}</td></tr>`
    )
    .join('');
};

/* ================= 版本结果 ================= */
loaders.runs = async () => {
  const { runs } = await api('/api/recon/runs');
  $('#runsTable tbody').innerHTML = runs
    .map(
      (r) => `<tr>
      <td>#${r.run_id}</td><td>${r.period}</td><td>v${r.version}</td>
      <td><span class="badge ${r.status === 'confirmed' ? 'matched' : 'pending_data'}">${r.status === 'confirmed' ? '✓ 已确认' : '⏳ 待确认'}</span></td>
      <td class="num">${r.total}</td><td class="num">${r.matched}</td><td class="num">${r.explainable}</td>
      <td class="num">${r.pending_data}</td><td class="num">${r.conflict}</td>
      <td class="num">${fmt(r.abs_diff)}</td>
      <td class="row-gap">
        <button class="btn sm" data-view="${r.run_id}">查看</button>
        ${r.status === 'open' ? `<button class="btn sm primary" data-confirm="${r.run_id}">确认冻结</button>` : ''}
      </td></tr>`
    )
    .join('');
  $$('#runsTable [data-view]').forEach((b) => b.addEventListener('click', () => showRunResults(Number(b.dataset.view))));
  $$('#runsTable [data-confirm]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api(`/api/recon/runs/${b.dataset.confirm}/confirm`, { method: 'POST', body: { actor: 'finance-ui' } });
        toast('已确认：结果冻结为不可变版本');
        loaders.runs();
        refreshAuditBadge();
      } catch (err) {
        toast('确认失败：' + err.message);
      }
    })
  );
};

async function showRunResults(runId) {
  const { results } = await api(`/api/recon/runs/${runId}/results`);
  $('#runResultsCard').hidden = false;
  $('#runResultsTitle').textContent = `运行 #${runId} 结果快照（${results.length} 笔）`;
  $('#runResultsTable tbody').innerHTML = results
    .map(
      (r) => `<tr><td>${esc(r.order_id)}</td><td class="num">${fmt(r.order_amount)}</td>
      <td class="num">${fmt(r.recognized_amount)}</td><td class="num">${fmt(r.invoiced_amount)}</td>
      <td class="num">${fmt(r.refunded_amount)}</td><td class="num"><strong>${fmtSigned(r.diff)}</strong></td>
      <td>${badge(r.classification)}</td><td class="mono">${esc(r.rule || '—')}</td></tr>`
    )
    .join('');
  $('#runResultsCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#runForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const period = $('#runPeriod').value;
  if (!period) return;
  try {
    const r = await api('/api/recon/run', { method: 'POST', body: { period, triggered_by: 'finance-ui' } });
    toast(`对账完成：${period} v${r.version} · 冲突 ${r.counts.conflict} 笔`);
    loaders.runs();
    refreshAuditBadge();
  } catch (err) {
    toast('对账失败：' + err.message);
  }
});

/* ================= 审计链状态 ================= */
async function refreshAuditBadge() {
  try {
    const v = await api('/api/audit/verify');
    const el = $('#auditBadge');
    el.className = 'audit-badge ' + (v.ok ? 'ok' : 'bad');
    el.textContent = v.ok ? `✓ 审计链完整 · ${v.entries} 条` : `✕ 审计链断裂 @${v.at}`;
  } catch {
    $('#auditBadge').textContent = '审计链状态未知';
  }
}

/* ================= 启动 ================= */
go(location.hash.slice(1) || 'overview');
refreshAuditBadge();
