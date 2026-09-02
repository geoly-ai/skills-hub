// 从 Sigstore bundle 里取出 DSSE envelope —— **两个 gate 共用一份**。
//
// 🔴 为什么抽出来：`check-attestation-bundle.mjs`（语义）与
//    `verify-attestation-signature.mjs`（密码学）都要做这一步。各写一遍就是
//    分叉的种子 —— 本仓库已经为「同一件事两处实现」吃过三次亏
//    （审批判定其实有三处、pr-classify 有两个调用点、frontmatter 检查只在一侧）。
export function dsseEnvelopeOf(bundle) {
  const dsse = bundle?.dsseEnvelope;
  if (!dsse) {
    const err = new Error('bundle 里没有 dsseEnvelope —— attestation 必须是 DSSE（§1.1 的封装契约）');
    err.violation = 'E_NOT_DSSE';
    throw err;
  }
  return {
    payloadType: dsse.payloadType,
    payload: dsse.payload,
    // ⚠️ `parseAttestationForForensics` 对 signatures[] 做 exact-keys 校验，
    //    只允许 sig 与可选的 keyid。cosign 可能带别的字段，这里**显式投影**，
    //    而不是把整个对象塞进去然后期待它宽容。
    signatures: (dsse.signatures ?? []).map((x) => {
      const out = { sig: x.sig };
      if (x.keyid !== undefined && x.keyid !== '') out.keyid = x.keyid;
      return out;
    }),
  };
}
