---
name: codex-thread-migrator
description: Find locally retained Codex tasks that disappeared after switching accounts or Providers, inventory and deduplicate them, then safely copy completed task history into tasks visible under the current Codex session by forking. Use whenever the user mentions missing Codex chats, old Provider conversations, another-account local records, restoring the Codex sidebar, or bulk-migrating local tasks.
compatibility: Requires Codex app thread tools (list_threads, read_thread, fork_thread); optional read-only access to ~/.codex/session_index.jsonl for complete local discovery.
---

# Codex Thread Migrator

Recover locally retained Codex task history after an account or Provider switch. Treat migration as a non-destructive copy: preserve every source task and create a current-session fork containing its completed history.

## Safety model

- Never edit authentication files, Provider identifiers, SQLite databases, rollout JSONL files, or the local task index.
- Never claim that a fork changes server-side ownership. It creates a new task from locally accessible completed history.
- Never delete, archive, rename, or modify a source task unless the user separately requests it.
- A fork contains completed history only. Clearly disclose that an active turn or unfinished response is not copied.
- Inventory first. Bulk-create forks only when the user explicitly asks to migrate all records or approves the inventory.
- Avoid duplicates by tracking source task IDs already forked during the current operation and by recognizing previously created migration copies.

## Workflow

### 1. Establish scope

Interpret “chat”, “conversation”, “thread”, and “task” as Codex tasks when the user refers to the Codex sidebar.

Determine whether the request is:

- discovery only;
- migration of named tasks;
- migration of all locally retained old tasks.

Do not treat ChatGPT web conversations or another account's server-only history as locally recoverable. This workflow applies only to tasks exposed by Codex app tools or retained in the local Codex index.

### 2. Discover current and old tasks

Start with `list_threads` using the largest accepted limit, normally 50. Use targeted `query` calls for names or keywords supplied by the user.

If the visible list appears incomplete and filesystem access is available, read `~/.codex/session_index.jsonl` in read-only mode. Extract the latest entry per task ID because the same task may have multiple title updates. Correlate IDs with files under `~/.codex/sessions/` only to confirm local retention; do not edit those files.

Build an inventory containing:

- source task ID;
- latest title;
- last update time when available;
- working directory when available;
- current visibility/status;
- migration status: source, current task, or already-created fork.

### 3. Deduplicate

Deduplicate by source task ID, not title. Titles can repeat and can change over time.

Exclude:

- the calling task;
- clearly current-session tasks that do not need migration;
- source IDs already migrated in this operation;
- an existing fork created from the same source when that relationship is known.

Do not exclude two distinct source IDs merely because they share a title.

### 4. Confirm the action boundary

For discovery-only requests, report the inventory and stop.

For one or more explicitly named tasks, fork those tasks without another confirmation.

For a broad but ambiguous request, show the count and representative titles, then ask whether to migrate all. If the user already said “全部”, “一并迁移”, “都迁过来”, or equivalent, proceed.

### 5. Migrate with forks

Call `fork_thread` for each selected source task with:

```json
{
  "threadId": "<source-task-id>",
  "environment": { "type": "same-directory" }
}
```

Use same-directory forks so the copied task preserves the original working-directory context. Process bulk migrations in moderate batches and record, for every source ID:

- success or failure;
- returned child task ID;
- error text when failed.

Continue past individual failures. Retry only transient failures; do not repeatedly fork a task after a success.

### 6. Verify

Run `list_threads` again and confirm that successful child task IDs are visible. For a small migration, optionally call `read_thread` on the child to confirm the title and completed history.

Open a migrated task with `navigate_to_codex_page` only when the user asks to open it, or when a single-task migration clearly implies continuing there. Do not repeatedly navigate during bulk migration.

### 7. Report the result

Lead with the outcome. Include:

- number discovered;
- number selected;
- number successfully migrated;
- failures and their titles/IDs;
- duplicate/skipped count;
- confirmation that sources were preserved;
- the completed-history limitation.

Use “迁移” as user-facing shorthand, but explain once that the mechanism is a safe fork/copy rather than a Provider ownership rewrite.

## Failure handling

### Task appears in the local index but cannot be forked

Report that its metadata remains locally indexed but Codex cannot load enough task state to create a fork. Offer to extract readable rollout content into a document only if the user wants a fallback archive.

### Another account's records are not present locally

Do not imply access. Explain that the user must log into that account or provide an export. Server-only history cannot be recovered by this skill.

### Provider switch caused disappearance

Do not modify local Provider fields or authentication configuration. Provider/account ownership is not represented as a safe editable field in the local task index. Use forks for locally accessible history.

## Example completion

> 已完成迁移：发现 34 条本地旧任务，成功复制 34 条，失败 0 条，跳过重复 1 条。原任务均保留未修改。新任务包含源任务中全部已完成的聊天历史；当时未完成的回复不会被复制。

## 埋点

这个 skill 由 `skills-hub` 分发，所以它的**安装 / 更新 / 卸载**会被计数：
`install` 成功收尾后静默发一次（24 小时最多一次、超时 1 秒、**失败不影响安装**）。
采集面是穷举白名单 —— 不含路径、目录清单、文件内容、命令行原文。

```sh
skills-hub telemetry status    # 看开关与队列
skills-hub stats               # 本地报表
skills-hub telemetry off       # 只关身份三项，匿名计数照发
GEOLY_TELEMETRY=0 skills-hub … # 完全关闭：本地一个字节都不写
```

🔴 **本 skill 自己不上报任何东西。** 被计数的是「这个 skill 被装了几次」，
**不是**「谁迁移了哪些任务」—— 任务 ID、标题、工作目录、迁移条数一个都不出本机。
采集面里根本没有能装下它们的字段。

⚠️ 平台请求日志会记录 IP，这一条我们关不掉 —— 是明确接受的残余风险，
不是「已缓解」。在意的话 `GEOLY_TELEMETRY=0` 是唯一彻底的办法。
