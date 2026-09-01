// 「页面上不出现任何使用情况数字」这条约束的词表与扫描器 —— 两种构建形态共用。
//
// 🔴 **不开例外。** 站点自己那句免责声明刻意写成「不展示任何形式的使用情况指标」，
//    一个具体的词都不列，就是为了让这张表能一直保持严格。
//    要往这张表里加例外之前先想想：真正的手滑长得跟例外一模一样。
//
// ⚠️ 它是**回归网，不是完整策略**：同义词、拼接出来的文本都拦不住。
//    主防线是「模型里连字段都不留」（lib/model.mjs）—— 没有数据源，模板就长不出一个数来。
//    这张表只负责挡住"在模板里手写一句"这种最常见的走样。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const BANNED = [
  '下载量', '下载数', '下载次数', '安装量', '安装数', '安装次数',
  '调用量', '调用数', '调用次数', '使用量', '使用次数', '装机量',
  '周活', '月活', '热度', '热门', '最受欢迎', '排行榜', '星标',
  'downloads', 'installs', 'install count', 'popularity', 'trending', 'most popular', 'stars',
  '即将上线', '敬请期待', 'coming soon', '暂无数据',
];

/** 递归收集目录下的文件；`exts` 为空表示全收。 */
export function walk(dir, exts = []) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts));
    else if (exts.length === 0 || exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

export function assertNoBannedWords(files, assert, stripPrefix = '') {
  for (const f of files) {
    const s = readFileSync(f, 'utf8').toLowerCase();
    for (const b of BANNED) {
      assert.ok(!s.includes(b.toLowerCase()), `${f.slice(stripPrefix.length)} 里出现了「${b}」`);
    }
  }
}
