# 会员积分系统 v2 API 参考

<!-- summary -->
本文档是会员积分系统 v2（account-service、redeem-service、rule-engine-service）的完整接口契约：账户查询、积分获取回调、积分兑换、规则查询、运营人工调整五组接口。当前版本：v1。鉴权方式：内部服务间 Bearer Token（网关签发）。
<!-- /summary -->

## 1. 接口总览

Base URL：测试环境 **https://test-api.internal.example.com**；生产环境 **https://api.internal.example.com**。

服务边界：本组接口覆盖积分账户查询、积分获取事件回调、积分消耗（抵扣/兑换）、规则查询、运营人工调整。不覆盖商品库存管理（属于商城服务）与会员等级评定任务的触发（属于内部定时任务，无对外接口）。

<!-- table: 接口清单 -->
| 方法 | 路径 | 简述 | 状态 |
|---|---|---|---|
| GET | /v1/points/accounts/{member_id} | 查询积分余额与流水 | 稳定 |
| POST | /v1/points/earn-events | 积分获取事件回调（订单支付成功等触发） | 稳定 |
| POST | /v1/points/redeem | 积分兑换（抵扣现金或兑换商品） | 稳定 |
| GET | /v1/rules/current | 查询当前生效规则 | 稳定 |
| POST | /v1/points/admin/adjust | 运营人工调整积分（补发/扣减） | 稳定 |

## 2. 鉴权

服务间调用使用 Bearer Token，Token 由内部网关基于服务身份签发，有效期 2 小时，过期需重新获取。Token 放在请求头 Authorization 字段。POST /v1/points/admin/adjust 额外要求 Token 携带 role=operator 的权限声明，缺失该声明返回 403。

```http
Authorization: Bearer eyJhbGciOi...
```

## 3. 通用约定

### 3.1 分页

列表类响应（本版本暂无列表接口，预留约定供后续扩展）统一使用 cursor 游标分页：请求携带 cursor 参数（可选，首页不传）与 limit 参数（默认 20，最大 100），响应携带 next_cursor 字段（为空表示无下一页）。

### 3.2 幂等

POST /v1/points/redeem、POST /v1/points/admin/adjust 支持幂等：请求头携带 Idempotency-Key，同一 key 在 24 小时内重复请求返回首次处理结果，不重复执行副作用。POST /v1/points/earn-events 天然幂等（按上游 order_id 与 event_type 去重，见 4.2 节）。

### 3.3 错误码表

<!-- table: 全局错误码 -->
| 错误码 | 含义 | 可操作恢复建议 |
|---|---|---|
| UNAUTHORIZED | Token 缺失或已过期 | 重新向网关获取 Token 后重试 |
| FORBIDDEN | Token 权限不足（如非 operator 调用人工调整接口） | 检查调用方身份是否具备所需角色 |
| RATE_LIMITED | 超出限流阈值 | 按 §5 的退避策略重试 |
| VALIDATION_ERROR | 请求参数不满足约束（类型 / 范围 / 必填） | 检查 error.detail 字段列出的具体字段 |
| INTERNAL_ERROR | 服务内部错误 | 记录 trace_id 联系值班，不建议无限重试 |

### 3.4 版本策略

版本号出现在 URL 路径（如 /v1/...）。破坏性变更会发布新的路径版本（如 /v2/...），旧版本按 §6 兼容与弃用节给出的下线时间保留至少 3 个月。非破坏性变更（新增可选字段）直接在当前版本发布，记入 §7 变更记录。

## 4. 接口详情

### 4.1 查询积分账户

**GET /v1/points/accounts/{member_id}**

<!-- table: 请求参数 -->
| 参数 | 类型 | 必填 | 取值范围 | 说明 |
|---|---|---|---|---|
| member_id | string | 是（路径参数） | 有效会员 ID | 要查询的会员 |
| include_ledger | boolean | 否 | true/false，默认 false | 是否包含近 90 天流水明细 |

权限：调用方需为受信内部服务或已登录会员本人（Token 中的 member_id 需与路径一致，运营角色可查询任意会员）。行为与副作用：无显式副作用（纯查询）。

```json
{
  "member_id": "m_10023",
  "balance": 1280,
  "ledger": [
    { "ledger_id": "L2026081000123", "amount": 50, "source": "order_pay", "created_at": "2026-08-10T09:12:00Z" }
  ]
}
```

<!-- table: 已知错误 -->
| 错误码 | 含义 | 恢复建议 |
|---|---|---|
| ACCOUNT_NOT_FOUND | 该会员尚未开通积分账户 | 检查 member_id 是否正确，或确认该会员是否完成注册流程（REQ-ACCT-01） |

### 4.2 积分获取事件回调

**POST /v1/points/earn-events**

<!-- table: 请求参数 -->
| 参数 | 类型 | 必填 | 取值范围 | 说明 |
|---|---|---|---|---|
| member_id | string | 是 | 有效会员 ID | 获得积分的会员 |
| event_type | string | 是 | order_pay / register / invite | 触发来源，对应 PRD REQ-EARN-01/02/03 |
| order_id | string | 按 event_type 而定 | event_type=order_pay 时必填 | 用于幂等去重与后续退款回收关联 |
| amount_basis | number | 是 | > 0 | 计算积分的基准金额（如订单实付金额） |

权限：仅限订单服务、注册服务、邀请服务等受信内部服务调用，不对外网开放。行为与副作用：按当前生效规则计算积分并写入账户流水（§3.2 幂等：同一 order_id 与 event_type 组合重复调用不重复发放）；若命中单日获取上限（REQ-EARN-04），本次调用仍返回成功但 points_granted 字段为 0 并在响应中标注 capped 为 true。

```json
{
  "member_id": "m_10023",
  "event_type": "order_pay",
  "order_id": "o_889201",
  "amount_basis": 299.00
}
```

```json
{
  "points_granted": 30,
  "capped": false,
  "ledger_id": "L2026081000124"
}
```

<!-- table: 已知错误 -->
| 错误码 | 含义 | 恢复建议 |
|---|---|---|
| RULE_NOT_FOUND | 当前无生效规则（规则引擎异常兜底场景） | 检查 rule-engine-service 健康状态，属于 tech-spec §7 失败模式的缓存兜底触发场景 |
| DUPLICATE_EVENT | 同一 order_id + event_type 已处理过 | 属于正常幂等行为，非错误，调用方按响应体的已有结果处理即可（此处列出仅供排查日志时区分） |

### 4.3 积分兑换

**POST /v1/points/redeem**

<!-- table: 请求参数 -->
| 参数 | 类型 | 必填 | 取值范围 | 说明 |
|---|---|---|---|---|
| member_id | string | 是 | 有效会员 ID | 发起兑换的会员 |
| sku_id | string | 是 | 有效商品 ID | 兑换的商品，对应 PRD REQ-REDEEM-02 |
| amount | integer | 是 | > 0 | 兑换数量 |
| coupon_code | string | 否 | 有效优惠券码 | 若同时使用优惠券，用于叠加限制校验（REQ-REDEEM-03） |

权限：会员本人或受信内部服务。行为与副作用：原子扣减积分与库存并生成兑换单（见 tech-spec §4.2 时序图）；触发兑换成功通知（异步，不阻塞响应）。幂等：是（Idempotency-Key 请求头必填）。

```json
{
  "member_id": "m_10023",
  "sku_id": "sku_8891",
  "amount": 1,
  "idempotency_key": "redeem_20260810_m10023_001"
}
```

<!-- table: 已知错误 -->
| 错误码 | 含义 | 恢复建议 |
|---|---|---|
| INSUFFICIENT_BALANCE | 积分余额不足 | 提示用户当前余额，不建议自动重试 |
| INSUFFICIENT_STOCK | 商品库存不足 | 提示用户更换商品，不建议重试同一 sku |
| RULE_CONFLICT | 违反积分与优惠券叠加限制 | 提示用户二选一，可重新提交不带 coupon_code 的请求 |
| LOCK_TIMEOUT | 数据库行锁等待超时（同商品高并发） | 按退避策略短暂延迟后重试，见 §5 |

### 4.4 查询当前生效规则

**GET /v1/rules/current**

<!-- table: 请求参数 -->
| 参数 | 类型 | 必填 | 取值范围 | 说明 |
|---|---|---|---|---|
| scope | string | 是 | member_id 或 tier 枚举值 | 查询范围，支持按会员或按等级查询（用于灰度场景） |

权限：受信内部服务。行为与副作用：无显式副作用（纯查询，命中本地缓存时不产生额外调用）。

```json
{
  "rule_version": "r_20260801_003",
  "earn_ratio": 0.1,
  "redeem_ratio": 100,
  "daily_earn_cap": 2000,
  "effective_at": "2026-08-01T00:00:00Z"
}
```

<!-- table: 已知错误 -->
| 错误码 | 含义 | 恢复建议 |
|---|---|---|
| RULE_NOT_FOUND | 该 scope 无匹配规则 | 检查灰度配置是否覆盖该会员/等级，或联系运营核实 |

### 4.5 运营人工调整积分

**POST /v1/points/admin/adjust**

<!-- table: 请求参数 -->
| 参数 | 类型 | 必填 | 取值范围 | 说明 |
|---|---|---|---|---|
| member_id | string | 是 | 有效会员 ID | 被调整的会员 |
| amount | integer | 是 | 非 0 整数，正数为补发、负数为扣减 | 调整数量 |
| reason | string | 是 | 非空，长度 ≤ 200 | 调整原因，写入审计日志（REQ-ADMIN-01） |

权限：仅限 role=operator 的 Token；amount 字段绝对值超过运营单次权限上限（当前配置 5000）时，接口返回 APPROVAL_REQUIRED。需通过审批流程另行提交。行为与副作用：写入积分流水并生成审计日志（操作人、原因、金额、时间）。幂等：是（Idempotency-Key 请求头必填）。

```json
{
  "member_id": "m_10023",
  "amount": -100,
  "reason": "误发放积分冲正，工单#20260810-07",
  "idempotency_key": "adjust_20260810_m10023_001"
}
```

<!-- table: 已知错误 -->
| 错误码 | 含义 | 恢复建议 |
|---|---|---|
| APPROVAL_REQUIRED | 调整金额超过单次权限上限 | 走审批流程，审批通过后由系统自动执行，不需要重复调用本接口 |

## 5. 限流与重试

<!-- table: 限流规则 -->
| 维度 | 规则 |
|---|---|
| 单会员 | /v1/points/redeem 每分钟最多 10 次 |
| 单服务调用方 | /v1/points/earn-events 每分钟最多 5000 次 |

重试建议：LOCK_TIMEOUT、RATE_LIMITED、INTERNAL_ERROR 可重试，建议指数退避（初始 200ms，最多重试 3 次，每次间隔翻倍）；INSUFFICIENT_BALANCE、INSUFFICIENT_STOCK、RULE_CONFLICT、VALIDATION_ERROR、APPROVAL_REQUIRED 为业务性失败，不建议自动重试，需人工或用户重新决策。

## 6. 兼容与弃用

<!-- table: 弃用接口 -->
| 接口 | 弃用原因 | 替代方案 | 下线时间 |
|---|---|---|---|
| POST /v0/points/deduct（v1 遗留接口，非本文档主体，仅记录迁移期兼容） | 被 /v1/points/redeem 的原子扣减方案取代 | POST /v1/points/redeem | 2026-10-01（迁移双写期结束后） |

## 7. 变更记录

<!-- table: 变更记录 -->
| 版本 | 日期 | 变更内容 | 破坏性 |
|---|---|---|---|
| v1.0 | 2026-08-10 | 初版发布，覆盖五组接口 | 否 |
