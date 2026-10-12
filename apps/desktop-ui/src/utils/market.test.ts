/**
 * market.ts 的单元测试（T-142 / D2）。
 * 运行：node --test apps/desktop-ui/src/utils/market.test.ts   （Node 内置，无需装依赖）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterItems, sortItems, resolveItems, type MarketItem } from './market.ts';

const MOCK: MarketItem[] = [
  { name: '社区生图', desc: '生成图片海报', cats: ['设计'], publisher: 'someone', verified: false, rating: 5, downloads: 100 },
  { name: 'GitHub', desc: '提交代码与审查', cats: ['开发工具'], publisher: 'EvaWorks', verified: true, rating: 3, downloads: 10 },
  { name: 'Notion', desc: '方案策划', cats: ['效率'], publisher: 'EvaWorks', verified: true, rating: 1, downloads: 1 },
  { name: 'Zotero', desc: '文献库', cats: ['学习', '效率'], publisher: 'x', verified: true, rating: 4, downloads: 50 },
];

test('filterItems: 分类过滤（"全部"与空 = 不限）', () => {
  assert.equal(filterItems(MOCK, { cat: '全部' }).length, 4);
  assert.equal(filterItems(MOCK, {}).length, 4);
  assert.deepEqual(filterItems(MOCK, { cat: '效率' }).map((i) => i.name), ['Notion', 'Zotero']);
  assert.equal(filterItems(MOCK, { cat: '不存在的分类' }).length, 0);
});

test('filterItems: 关键词过滤（大小写不敏感，匹配名称或描述）', () => {
  assert.deepEqual(filterItems(MOCK, { q: 'github' }).map((i) => i.name), ['GitHub']);
  assert.deepEqual(filterItems(MOCK, { q: '图片' }).map((i) => i.name), ['社区生图']);
  assert.equal(filterItems(MOCK, { q: '不存在的关键词' }).length, 0);
});

test('filterItems: 分类与关键词叠加', () => {
  assert.deepEqual(filterItems(MOCK, { cat: '效率', q: '文献' }).map((i) => i.name), ['Zotero']);
  assert.equal(filterItems(MOCK, { cat: '开发工具', q: '文献' }).length, 0);
});

test('sortItems: trust = 官方 > 已验证 > 社区，同级比评分再比安装量', () => {
  assert.deepEqual(
    sortItems(MOCK, 'trust').map((i) => i.name),
    ['GitHub', 'Notion', 'Zotero', '社区生图'],
  );
});

test('sortItems: rating = 纯评分优先', () => {
  assert.deepEqual(sortItems(MOCK, 'rating').map((i) => i.name), ['社区生图', 'Zotero', 'GitHub', 'Notion']);
});

test('sortItems: downloads = 纯安装量优先', () => {
  assert.deepEqual(sortItems(MOCK, 'downloads').map((i) => i.name), ['社区生图', 'Zotero', 'GitHub', 'Notion']);
});

test('sortItems: 缺失/非法字段不崩，按 0 处理并用名称做稳定兜底', () => {
  const messy = [{ name: 'b', rating: 'x' as unknown as number }, { name: 'a' }] as MarketItem[];
  // 两个 rating 都视作 0 → 信任级相同 → 按名称升序，结果确定且稳定
  assert.deepEqual(sortItems(messy, 'rating').map((i) => i.name), ['a', 'b']);
  assert.deepEqual(sortItems(messy, 'trust').map((i) => i.name), ['a', 'b']);
  assert.equal(sortItems(messy, 'downloads').length, 2);
});

test('sortItems: 不改动入参（纯函数）', () => {
  const before = MOCK.map((i) => i.name);
  sortItems(MOCK, 'rating');
  assert.deepEqual(MOCK.map((i) => i.name), before);
});

test('resolveItems: 离线 → 用 mock 并套用同一套过滤+排序', async () => {
  const r = await resolveItems({ online: false, fetchRemote: async () => [], mock: MOCK, cat: '全部', sort: 'trust' });
  assert.deepEqual(r.map((i) => i.name), ['GitHub', 'Notion', 'Zotero', '社区生图']);
  const r2 = await resolveItems({ online: false, fetchRemote: async () => [], mock: MOCK, cat: '效率', sort: 'rating' });
  assert.deepEqual(r2.map((i) => i.name), ['Zotero', 'Notion']);
});

test('resolveItems: 在线 → 用后端数据（后端已过滤排序，不再二次处理）', async () => {
  const remote: MarketItem[] = [{ name: '远端项', desc: 'x' }];
  const r = await resolveItems({ online: true, fetchRemote: async () => remote, mock: MOCK, cat: '效率', sort: 'rating' });
  assert.deepEqual(r.map((i) => i.name), ['远端项'], '在线时不应被本地 cat/sort 覆盖');
});

test('resolveItems: 声称在线但请求失败 → 如实回退本地，不空白', async () => {
  const r = await resolveItems({
    online: true,
    fetchRemote: async () => { throw new Error('后端不可达'); },
    mock: MOCK,
    sort: 'trust',
  });
  assert.equal(r.length, 4);
  assert.equal(r[0].name, 'GitHub');
});
