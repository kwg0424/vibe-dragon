import { pullVault, pushVault } from "./webdav.js";
import { encryptVault, decryptVault, WrongKeyError, TITLE } from "./crypto.js";
import { credentialSecret } from "./key.js";

// 서버(WebDAV) 모드 동기화. 사이트 목록은 기기에는 평문(chrome.storage.local), 서버에는 암호문으로 둔다.
// local: { sites, baseEtag(마지막 동기화 때 서버 ETag, 처음 연결이면 null), dirty(서버에 안 올린 변경) }
// 서버와 이 기기 양쪽이 모두 바뀌었으면 묻지 않고 합친다 (양쪽 사이트를 모두 남기는 쪽으로).
// 반환: { sites, baseEtag, action: "created" | "pushed" | "merged" | "pulled" | "unchanged" }
export async function sync(cfg, local) {
  const secret = credentialSecret(cfg);
  const remote = await pullVault(cfg);

  let remoteSites = null;
  if (remote.blob) {
    try {
      remoteSites = normalizeSites((await decryptVault(remote.blob, secret)).sites);
    } catch (e) {
      if (!(e instanceof WrongKeyError)) throw e;
    }
  }

  const push = async (sites, action) => {
    // 서버 파일과 같은 salt 를 쓰면 키 파생(600k)을 다시 하지 않는다
    const blob = await encryptVault({ sites }, secret, remoteSites ? remote.blob : undefined);
    const res = await pushVault(cfg, remote.etag, blob);
    if (res.conflict) throw new Error("동기화 중 서버 데이터가 바뀌었습니다. 다시 시도하세요");
    return { sites, baseEtag: res.etag, action };
  };
  const pulled = () => ({ sites: remoteSites, baseEtag: remote.etag, action: "pulled" });

  if (!remote.blob) return push(local.sites, local.baseEtag ? "pushed" : "created");

  // 같은 아이디·비밀번호면 같은 키라 정상이라면 열린다 → 못 열면 파일이 손상된 것. 합칠 수 없으니 이 기기 목록으로 다시 쓴다
  if (!remoteSites) return push(local.sites, "pushed");

  if (!local.dirty) {
    // 제목 없는 예전 서버 파일: 목록은 그대로 두고 제목을 붙여 다시 쓴다
    if (remote.blob.title !== TITLE) return { ...(await push(remoteSites, "pushed")), action: remote.etag === local.baseEtag ? "unchanged" : "pulled" };
    if (remote.etag === local.baseEtag) return { sites: local.sites, baseEtag: local.baseEtag, action: "unchanged" };
    return pulled();
  }

  if (remote.etag === local.baseEtag) return push(local.sites, "pushed");

  // 양쪽 모두 바뀜 → 합치기. 합친 결과가 서버와 같으면 올릴 것이 없다
  const merged = mergeSites(remoteSites, local.sites);
  if (sameSites(merged, remoteSites)) return sameSites(local.sites, remoteSites) ? { ...pulled(), action: "unchanged" } : pulled();
  return push(merged, "merged");
}

// 양쪽 사이트를 모두 남기고, 같은 사이트는 이 기기 설정을 쓴다 (한쪽에서 지운 사이트는 다시 살아난다)
export function mergeSites(remote, local) {
  return { ...remote, ...local };
}

export function sameSites(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && !!a[k].copy === !!b[k].copy && !!a[k].strong === !!b[k].strong);
}

// 두 모드가 모두 꺼진 사이트는 목록에 두지 않는다 (1.4.0 이 올린 파일에 남아 있을 수 있음)
function normalizeSites(sites) {
  const out = {};
  for (const [host, conf] of Object.entries(sites || {})) {
    if (conf?.copy || conf?.strong) out[host] = { copy: !!conf.copy, strong: !!conf.strong };
  }
  return out;
}

// 연결할 때 묻기 전에 서버 목록만 본다 → { etag, sites } (파일이 없거나 열 수 없으면 sites: null)
export async function peekRemote(cfg) {
  const remote = await pullVault(cfg);
  if (!remote.blob) return { etag: null, sites: null };
  try {
    return { etag: remote.etag, sites: normalizeSites((await decryptVault(remote.blob, credentialSecret(cfg))).sites) };
  } catch (e) {
    if (!(e instanceof WrongKeyError)) throw e;
    return { etag: remote.etag, sites: null };
  }
}
