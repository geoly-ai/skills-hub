// 站点构建期用到的几个仓库路径。
//
// 🔴 **一律从 `import.meta.url` 往上推，不用 `process.cwd()`。**
//    Vercel 的 Root Directory 设成 `site` 之后 cwd 就是 `site/`，而 checkout 仍是整个仓库；
//    本地又可能从仓库根跑 `npm run build --prefix site`。两种 cwd 都出现过，
//    以 cwd 为基准的相对路径会在其中一种下静默指到不存在的目录 ——
//    而「目录不存在」在本站点的语义里是**空 registry**（正常出页），不是报错，
//    于是错误的基准会伪装成「registry 是空的」这种看起来完全正常的结果。
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** 仓库根（`site/lib/paths.mjs` → 上两级）。 */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** 站点自己的根。 */
export const SITE_ROOT = fileURLToPath(new URL('../', import.meta.url));

/** 签名快照所在目录（02-registry.md §1）。 */
export const SNAPSHOTS_DIR = join(REPO_ROOT, 'registry', 'snapshots');

/** 制品载荷的不可变区（01-artifacts.md §1）。当前仓库里**尚不存在**。 */
export const ARTIFACTS_DIR = join(REPO_ROOT, 'artifacts');

/** 构建产物：站点数据。被 Next 的页面 import，故必须在 `next build` 之前写好。 */
export const DATA_FILE = join(SITE_ROOT, '.generated', 'site-data.json');
