// 最小探针：不 import 任何东西。用来把「函数根本起不来」与「我们的代码抛错」分开。
export default function handler(req, res) {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, node: process.version, hasDbUrl: Boolean(process.env.DATABASE_URL) }));
}
