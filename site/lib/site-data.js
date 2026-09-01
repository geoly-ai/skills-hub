// 页面读数据的唯一入口。
//
// 🔴 数据是 **`build.mjs` 在 `next build` 之前生成的构建期输入**（package.json 的
//    `prebuild`）。页面 import 它，等于把那一刻的事实编译进 HTML —— 运行时不查后端、
//    不发请求，页面上写的每个字都能追回到那一次构建读的那张快照。
//
// ⚠️ 这份 JSON 不进版本库（根 .gitignore 里有 `site/.generated/`）。
//    没跑 `node build.mjs` 就 `next build` 会在这里因为文件不存在而失败 ——
//    这是**对的**：一个"数据文件不见了就渲染成空站点"的兜底，会让"registry 是空的"
//    这句本该有意义的话，变成"构建漏了一步"的同义词。

import data from '../.generated/site-data.json';

export function getSiteData() {
  return data;
}

export function isEmptyRegistry() {
  return data.empty === true;
}

/** 空 registry 时返回空数组 —— 调用方据此产出 0 个静态页面，而不是一批空壳页。 */
export function getArtifacts() {
  return data.empty ? [] : data.artifacts;
}

export function getGroups() {
  return data.empty ? [] : data.groups;
}

export function findArtifact({ kind, namespace, name, version }) {
  return getArtifacts().find(
    (a) => a.kind === kind && a.namespace === namespace && a.name === name && a.version === version,
  );
}

/**
 * 全局搜索用的**极小索引**：只有 id / href / 两个摘要。
 *
 * 🔴 刻意不是全量 record —— 它会被编译进**每一页**，而全局搜索只需要回答
 *    「这串东西对应哪个制品」。把整份视图模型塞进每一页，页面体积会随 registry
 *    线性膨胀，而多出来的字段一个都用不上。
 */
export function getSearchIndex() {
  return getArtifacts().map((a) => ({
    id: a.id, href: a.href, tree: a.tree_digest, asset: a.asset.sha256,
  }));
}

export function findGroup({ kind, namespace, name }) {
  const group = getGroups().find((g) => g.kind === kind && g.namespace === namespace && g.name === name);
  if (group === undefined) return undefined;
  const byId = new Map(getArtifacts().map((a) => [a.id, a]));
  return { ...group, versions: group.versions.map((id) => byId.get(id)) };
}
