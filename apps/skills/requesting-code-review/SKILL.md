---
name: requesting-code-review
description: 完成���务前派子代理评审
category: 工程实践
source: obra/superpowers
---

# 请求代码评审

派一个评审子代理，在问题扩散之前把它抓出来。给评审者的必须是**精确构造的上下文**——绝不是你的会话历史。

**核心原则：早评审，常评审。**

## 什么时候请求评审

**必须**：
- 子代理驱动开发里，每完成一个任务
- 完成重要功能之后
- 合并到主干之前

**可选但有价值**：
- 卡住了（换个视角）
- 重构之前（先取个基线）
- 修完复杂 bug 之后

## 怎么请求

**1. 取 git SHA**（界定评审范围）
```bash
BASE_SHA=$(git rev-parse HEAD~1)        # 或：git merge-base origin/main HEAD
HEAD_SHA=$(git rev-parse HEAD)
```

**2. 派评审子代理**

用 `delegate` 派一个子代理，参照 [code-reviewer.md](code-reviewer.md) 这个模板填写。

**占位符**：
- `{DESCRIPTION}` — 你这次做了什么（一两句）
- `{PLAN_OR_REQUIREMENTS}` — 它**应该**做到什么（需求/计划出处）
- `{BASE_SHA}` — 起点提交
- `{HEAD_SHA}` — 终点提交

⚠️ 本项目里没有 `general-purpose` 这种预设角色，直接 `delegate`，并在 goal 里把上面四项写清楚。

**3. 按反馈行动**
- **Critical** → 立刻修
- **Important** → 继续推进前修掉
- **Minor** → 记下来，以后再说
- 评审者不对时 → **摆理由反驳**，别默默照改

## 示例

```
[刚做完任务 2：加了校验函数]

你：推进之前先请人评审一下。

BASE_SHA=$(git log --oneline | grep "Task 1" | head -1 | awk '{print $1}')
HEAD_SHA=$(git rev-parse HEAD)

[派评审子代理]
  DESCRIPTION: 新增 verifyIndex() 与 repairIndex()，覆盖 4 类问题
  PLAN_OR_REQUIREMENTS: 计划文档里的任务 2
  BASE_SHA: a7981ec
  HEAD_SHA: 3df7661

[子代理返回]
  优点：结构干净，测试是真的
  问题：
    Important：缺少进度指示
    Minor：上报间隔用了魔法数字 100
  结论：可以推进

你：[补上进度指示]
[继续任务 3]
```

## 常见借口

| 借口 | 事实 |
|---|---|
| "我自己看一眼 diff 就行了" | 你是协调者，内联读 diff 会烧掉你还要用来推进工作的上下文。派评审子代理：diff 与评估过程留在**它**的上下文里，回到你这儿的只有结论 |
| "评审者需要我的完整会话历史才能理解" | 给它精确构造的上下文，**永远不要给会话历史**。这样它看的是**作品**，不是你的思考过程 |

## 红旗

**绝不**：
- 因为"这很简单"就跳过评审
- 忽略 Critical 问题
- 带着没修的 Important 问题继续推进
- 和有效的技术意见争论

**如果评审者错了**：
- 用技术理由反驳
- 摆出能证明它能跑的代码／测试
- 请求澄清

---

**与本项目的关系**：本项目有 `delegate` 工具（子代理，独立上下文、内部 fail-closed），
也有 `code-review` 技能（人工评审清单）。两者不冲突：
`code-review` 是**自己或人**按清单看，`requesting-code-review` 是**派子代理**独立看。
两者都做最好——子代理抓逻辑漏洞，人抓产品意图。

**注意**：评审子代理只会**看**不会**改**（它内部是 never 档）。所以它的意见要**你**去落实，
别指望它顺手就修了。