# 收入确认对账工具（revrec-recon）

连接**订单、履约、开票、退款**四路数据，按期间核对"履约确认收入 vs 开票净额"，
把差异分为**可解释 / 待补数据 / 真实冲突**，调整审批后生成**不可变审计记录**。
零外部依赖：Node.js（≥22.5）内置 `node:sqlite` + `node:http`，前端为原生 HTML/JS。

## 快速开始

```bash
npm run seed     # 生成演示数据（9 个订单覆盖全部场景）
npm start        # http://localhost:3000
npm run verify   # 端到端验证（34 项断言：跨月、重复消息、回补幂等、账本不可变…）
```

## 页面

| 页面 | 内容 |
|---|---|
| 总览 | 冲突 Hero 数、三链路指标、差异分类分布（分段条形图 + 表格）、审计流水 |
| 对账链路 | 单订单资金链路时间线：创建 → 金额修订 → 拆单履约 → 开票/红冲 → 退款 → 调整，右侧三链路汇总 |
| 差异证据 | 按分类筛选差异，展开查看证据（履约/发票/退款/修订明细），一键发起调整 |
| 调整审批 | 待审批调整通过/驳回；通过即入账并写审计链 |
| 版本结果 | 每次对账生成版本化快照；确认后冻结不可变；可对任意期间重跑 |

## 差异分类规则（按优先级）

1. **待补数据**：`invoice_missing`（已履约无发票）、`fulfillment_missing`（已开票无履约）、`refund_unmatched`
2. **可解释**（金额须完全吻合）：
   - `cross_period` 跨期履约——发票在本期、交付在下期，收入应在交付期确认
   - `partial_fulfillment` 拆单部分履约——发票全额、履约分批
   - `amount_revision` 金额修订——订单改价后发票仍按旧价
   - `red_flush_pending_reinvoice` 红冲后待重开
   - `refund_pending_credit` 退款已冲收入、发票待贷记
3. **真实冲突**：无任何规则可解释的金额分歧

## 不重复记账（幂等）的三道防线

- `(source, message_id)` 唯一约束：重复投递判重跳过，只记 `ingest.duplicate` 审计
- 业务实体以业务键唯一（`fulfillment_id` / `invoice_id` / `refund_id` / 修订 `message_id`）
- 调整入账 `adjustment_entries.adjustment_id` 唯一：审批只生效一次，重复审批被拒绝

来源回补（`POST /api/backfill`）复用同一套幂等逻辑：历史消息全部判重，仅迟到消息入账。

## 不可变审计

`audit_ledger` 为 SHA-256 哈希链（`hash = sha256(prev_hash|type|ref|payload|ts)`），
数据库触发器禁止 UPDATE/DELETE；`GET /api/audit/verify` 逐条重算校验。
对账运行确认（`POST /api/recon/runs/:id/confirm`）后结果快照冻结，重跑生成新版本。

## API 摘要

```
POST /api/ingest                 单条消息 {source, message_id, event_type, occurred_at, payload}
POST /api/backfill               来源回补 {messages:[...], label}
POST /api/recon/run              执行对账 {period:"YYYY-MM"}
POST /api/recon/runs/:id/confirm 确认冻结
GET  /api/recon/runs             版本列表（含分类统计）
GET  /api/recon/runs/:id/results 结果快照（?classification= 过滤）
GET  /api/orders/:id/chain       订单对账链路
POST /api/adjustments            发起调整 {result_id, side, amount, reason}
POST /api/adjustments/:id/decide 审批 {decision: approved|rejected}
GET  /api/audit/verify           审计链校验
GET  /api/summary                总览指标
```

消息事件类型：`order.created` / `order.amount_revised` / `fulfillment.delivered` /
`invoice.issued` / `invoice.red_flushed` / `refund.completed`。金额单位：元（摄入层转分存储）。

## 演示场景（`src/seed.js`）

| 订单 | 场景 | 10 月分类 | 11 月（回补/跨期后） |
|---|---|---|---|
| O-1001 | 正常 | 无差异 | 无差异 |
| O-1002 | 拆单 ¥3000 分两批发货 | 可解释·部分履约 | 无差异（回补第二笔履约） |
| O-1003 | 跨期：10 月开票 11 月交付 | 可解释·跨期履约 | 无差异（收入落在 11 月） |
| O-1004 | 开错票→红冲→重开 | 无差异（冲销闭环） | 无差异 |
| O-1005 | 开票后订单改价 ¥1000→¥800 | 可解释·金额修订 | 调整审批后归零 |
| O-1006 | 票 ¥1750 vs 货 ¥1500 | **真实冲突** | 真实冲突 |
| O-1007 | 已履约、发票未同步 | 待补数据 | 待补数据 |
| O-1008 | 退款 ¥200 待贷记 | 可解释·退款待贷记 | 可解释 |
| O-1009 | 发票全额红冲待重开 | 可解释·红冲待重开 | 可解释 |

## 目录

```
src/db.js        schema + 事务助手（金额一律整数分）
src/ingest.js    幂等摄入与规范化、来源回补
src/reconcile.js 对账引擎：三链路核对、分类规则、版本化运行、调整审批
src/ledger.js    哈希链审计账本（append-only + 触发器）
src/seed.js      演示场景数据
src/server.js    HTTP API + 静态页面
public/          五页面前端（总览/链路/差异/审批/版本）
test/verify.js   34 项端到端断言
```
