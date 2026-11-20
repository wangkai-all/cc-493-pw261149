'use strict';
// HTTP 服务：JSON API + 静态页面。零外部依赖。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('./db');
const { ingest, backfill } = require('./ingest');
const recon = require('./reconcile');
const ledger = require('./ledger');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5 * 1024 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('JSON 解析失败: ' + e.message));
      }
    });
    req.on('error', reject);
  });
}

function createApp(db) {
  // ---- API 路由 ----
  const routes = {
    'GET /api/health': () => ({ ok: true, time: new Date().toISOString() }),

    'POST /api/ingest': async (req) => ingest(db, await readBody(req)),

    'POST /api/backfill': async (req) => {
      const body = await readBody(req);
      if (!Array.isArray(body.messages)) throw new Error('messages 必须是数组');
      return backfill(db, body.messages, body.label || 'api-backfill');
    },

    'POST /api/recon/run': async (req) => {
      const body = await readBody(req);
      if (!/^\d{4}-\d{2}$/.test(body.period || '')) throw new Error('period 格式应为 YYYY-MM');
      return recon.runRecon(db, body.period, body.triggered_by || 'api');
    },

    'GET /api/recon/runs': () => {
      const runs = db
        .prepare(
          `SELECT r.*,
             (SELECT COUNT(*) FROM recon_results x WHERE x.run_id=r.run_id) AS total,
             (SELECT COUNT(*) FROM recon_results x WHERE x.run_id=r.run_id AND x.classification='matched') AS matched,
             (SELECT COUNT(*) FROM recon_results x WHERE x.run_id=r.run_id AND x.classification='explainable') AS explainable,
             (SELECT COUNT(*) FROM recon_results x WHERE x.run_id=r.run_id AND x.classification='pending_data') AS pending_data,
             (SELECT COUNT(*) FROM recon_results x WHERE x.run_id=r.run_id AND x.classification='conflict') AS conflict,
             (SELECT COALESCE(SUM(ABS(x.diff)),0) FROM recon_results x WHERE x.run_id=r.run_id) AS abs_diff
           FROM recon_runs r ORDER BY r.run_id DESC`
        )
        .all();
      return { runs };
    },

    'POST /api/recon/runs/:id/confirm': async (req, p) => {
      const body = await readBody(req);
      return recon.confirmRun(db, Number(p.id), body.actor || 'api');
    },

    'GET /api/recon/runs/:id/results': (req, p, query) => {
      const where = query.classification ? 'AND classification=?' : '';
      const args = query.classification ? [Number(p.id), query.classification] : [Number(p.id)];
      const results = db
        .prepare(`SELECT * FROM recon_results WHERE run_id=? ${where} ORDER BY ABS(diff) DESC, order_id`)
        .all(...args);
      return { results: results.map((r) => ({ ...r, evidence: JSON.parse(r.evidence) })) };
    },

    'GET /api/orders': () => ({
      orders: db.prepare(`SELECT * FROM orders ORDER BY order_id`).all(),
    }),

    'GET /api/orders/:id/chain': (req, p) => {
      const chain = recon.getChain(db, decodeURIComponent(p.id));
      if (!chain) throw Object.assign(new Error('订单不存在'), { status: 404 });
      return chain;
    },

    'GET /api/adjustments': (req, p, query) => {
      const where = query.status ? 'WHERE a.status=?' : '';
      const args = query.status ? [query.status] : [];
      return {
        adjustments: db
          .prepare(
            `SELECT a.*, r.diff AS result_diff, r.classification, r.rule, r.run_id
             FROM adjustments a JOIN recon_results r ON r.id=a.result_id ${where}
             ORDER BY a.adjustment_id DESC`
          )
          .all(...args),
      };
    },

    'POST /api/adjustments': async (req) => recon.createAdjustment(db, await readBody(req)),

    'POST /api/adjustments/:id/decide': async (req, p) => {
      const body = await readBody(req);
      return recon.decideAdjustment(db, Number(p.id), body.decision, body.actor || 'api');
    },

    'GET /api/audit': (req, p, query) => ({
      entries: db
        .prepare(`SELECT * FROM audit_ledger ORDER BY seq DESC LIMIT ?`)
        .all(Math.min(Number(query.limit) || 50, 500)),
    }),

    'GET /api/audit/verify': () => ledger.verifyChain(db),

    'GET /api/summary': (req, p, query) => {
      const runId = query.run_id
        ? Number(query.run_id)
        : (db.prepare(`SELECT run_id FROM recon_runs ORDER BY run_id DESC LIMIT 1`).get() || {}).run_id;
      if (!runId) return { run_id: null };
      const run = db.prepare(`SELECT * FROM recon_runs WHERE run_id=?`).get(runId);
      const byClass = db
        .prepare(
          `SELECT classification, COUNT(*) n, COALESCE(SUM(ABS(diff)),0) abs_diff
           FROM recon_results WHERE run_id=? GROUP BY classification`
        )
        .all(runId);
      const totals = db
        .prepare(
          `SELECT COALESCE(SUM(recognized_amount),0) recognized, COALESCE(SUM(invoiced_amount),0) invoiced,
                  COALESCE(SUM(refunded_amount),0) refunded
           FROM recon_results WHERE run_id=?`
        )
        .get(runId);
      const pendingAdj = db.prepare(`SELECT COUNT(*) n FROM adjustments WHERE status='pending'`).get().n;
      return { run_id: runId, run, by_class: byClass, totals, pending_adjustments: pendingAdj };
    },
  };

  // 动态段路由匹配：/api/recon/runs/:id/results 等
  function matchRoute(method, pathname) {
    const key = `${method} ${pathname}`;
    if (routes[key]) return { handler: routes[key], params: {} };
    for (const routeKey of Object.keys(routes)) {
      const [m, pattern] = routeKey.split(' ');
      if (m !== method || !pattern.includes(':')) continue;
      const pSeg = pattern.split('/');
      const uSeg = pathname.split('/');
      if (pSeg.length !== uSeg.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < pSeg.length; i++) {
        if (pSeg[i].startsWith(':')) params[pSeg[i].slice(1)] = uSeg[i];
        else if (pSeg[i] !== uSeg[i]) { ok = false; break; }
      }
      if (ok) return { handler: routes[routeKey], params };
    }
    return null;
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const query = Object.fromEntries(url.searchParams);
    try {
      const matched = matchRoute(req.method, url.pathname);
      if (matched) {
        const out = await matched.handler(req, matched.params, query);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out));
        return;
      }
      // 静态文件
      if (req.method === 'GET') {
        let file = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
        if (!file.startsWith(PUBLIC_DIR)) throw Object.assign(new Error('禁止访问'), { status: 403 });
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
          fs.createReadStream(file).pipe(res);
          return;
        }
      }
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    } catch (e) {
      const status = e.status || (/不存在|必须|非法|未知|不能|格式/.test(e.message) ? 400 : 500);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

if (require.main === module) {
  const db = openDb();
  // 空库自动播种，便于直接体验
  const hasData = db.prepare(`SELECT COUNT(*) n FROM source_messages`).get().n > 0;
  if (!hasData) {
    const { seed } = require('./seed');
    seed(db).forEach((l) => console.log('•', l));
  }
  const port = Number(process.env.PORT || 3000);
  createApp(db).listen(port, () => console.log(`收入确认对账工具: http://localhost:${port}`));
}

module.exports = { createApp };
