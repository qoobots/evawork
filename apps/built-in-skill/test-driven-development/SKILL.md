---
name: test-driven-development
description: 实现功能或修 bug、且仓库已有测试体系、需要先写会失败的测试时
category: 工程实践
source: obra/superpowers（中文改编）
---

# 测试驱动开发（TDD）

## 概述

先写测试。看着它失败。再写刚好能通过的最少代码。

**核心原则：如果你没有亲眼看着测试失败过，你就不知道它在测对东西。**

违反它的字面，就是违反它的精神。

## 何时使用

**永远**：
- 新功能
- 修 bug
- 重构
- 行为变更

**例外（要问过用户）**：
- 一次性原型
- 生成的代码
- 配置文件

在想"就这一次跳过 TDD"？停下。那是在自我说服。

## 铁律

```
没有先看到一个失败的测试，就不许写实现代码
```

先写了代码再写测试？**删掉，重新开始。**

**没有例外**：
- 不要把它留着当"参考"
- 不要"边写测试边照着它抄"
- 不要看着它写
- 删掉就是删掉

从测试出发重新实现。就这么定了。

## 红 → 绿 → 重构

```
   ┌──────────────────────────────────────────┐
   │                                          │
   ▼                                          │
[RED]  写一个失败的测试                        │
   │                                          │
   ▼                                          │
验证它**以正确的原因**失败 ──失败原因不对──→ 回到 RED
   │ 是
   ▼
[GREEN] 写刚好能通过的最少代码                  │
   │                                          │
   ▼                                          │
验证它通过（全绿） ──没通过──→ 回到 GREEN      │
   │ 是                                       │
   ▼                                          │
[REFACTOR] 清理（保持全绿）───────────────────┘
   （重构后必须重新验证仍是绿的）
```

### RED —— 写失败的测试

写一个最小的测试，说明**应该发生什么**。

**好**
```typescript
test('retries failed operations 3 times', async () => {
  let attempts = 0;
  const operation = () => {
    attempts++;
    if (attempts < 3) throw new Error('fail');
    return 'success';
  };

  const result = await retryOperation(operation);

  expect(result).toBe('success');
  expect(attempts).toBe(3);
});
```
名字清楚、测的是真实行为、只测一件事。

**坏**
```typescript
test('retry works', async () => {
  const mock = jest.fn()
    .mockRejectedValueOnce(new Error())
    .mockRejectedValueOnce(new Error())
    .mockResolvedValueOnce('success');
  await retryOperation(mock);
  expect(mock).toHaveBeenCalledTimes(3);
});
```
名字含糊、测的是 mock 而不是代码。

**要求**：
- 一个测试只测一种行为
- 名字说清"什么行为、什么条件"
- 测真实代码（除非万不得已，别用 mock）

### 验证 RED —— 看着它失败

**必须。绝不能跳。**

```bash
npm test path/to/test.test.ts
```

确认三件事：
- 测试**失败**（不是报错）
- 失败信息是**预期中的**那个
- 它因为**功能缺失**而失败（不是拼写错误）

**测试直接过了？** 你在测已有的行为。改测试。
**测试报错？** 修错误，重跑，直到它**以正确的方式失败**。

### GREEN —— 最少代码

写刚好能让测试通过的代码。

**好**
```typescript
async function retryOperation<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 3; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === 2) throw e;
    }
  }
  throw new Error('unreachable');
}
```
刚好够用。

**坏**
```typescript
async function retryOperation<T>(
  fn: () => Promise<T>,
  options?: {
    maxRetries?: number;
    backoff?: 'linear' | 'exponential';
    onRetry?: (attempt: number) => void;
  }
): Promise<T> {
  // YAGNI
}
```
过度设计。

不要顺手加功能、不要重构别的代码、不要"顺手优化"超���测试要求的范围。

### 验证 GREEN —— 看着它通过

**必须。**

```bash
npm test path/to/test.test.ts
```

看到通过，再进下一步。

### 重构 —— 在全绿的前提下清理

- 消除重复
- 改善命名
- 提取函数
- **每改一下就重跑测试**，保持全绿

重构时不改变行为——那是 TDD 的范畴，不是重构的。

## 反模式（见到就改）

| 反模式 | 问题 |
|---|---|
| 先写实现，补测试 | 测试会照着实现写，永远通过——证明不了任何事 |
| 测试和实现同时写 | 你会不自觉地按实现写断言 |
| 一个测试测一堆行为 | 失败时不知道是哪件事坏了 |
| 只断言"没抛异常" | 什么都没验证 |
| 用 mock 掩盖真问题 | 测的是你的 mock 行为，不是代码行为 |
| 跳过"看它失败" | 你不知道测试对不对；这是整套流程唯一不可省略的一步 |
| 为了让测试通过而改测试 | 把真正的 bug 藏起来了 |
| 测试里写业务逻辑 | 逻辑错两次 |

## 红旗

- "这个太简单了不用测"
- "先写完再补测试也一样"
- "测试跑过了就行"（哪个测试？刚才那次吗）
- "这里是 mock 出来的，不是真逻辑"
- "覆盖率已经很高了"（覆盖率高不等于测对了）

## 与本项目的关系

- 用 `run_command` 跑测试并**读完整输出**（别只看最后一行）
- 改代码用 `sed`/`python`/`patch` 等，改完重跑测试
- 大改动前可以先开**隔离副本**（TS-061），失败就直接丢弃，不影响工作区
- 更多关于"怎么写好测试"：见同目录 [writing-good-tests.md](writing-good-tests.md)