// 사이트 목록 저장소. 저장 방식은 두 가지:
//   browser (기본): chrome.storage.sync 에 사이트마다 키 하나 ("site:example.com" -> { c: 1, s: 0 }).
//                   Edge 에 로그인하고 동기화를 켜 두면 같은 계정의 다른 PC로 자동 전파된다.
//                   (sync 한도: 항목당 8KB, 전체 100KB, 최대 512개 → 사이트 수백 개까지 충분)
//   server        : chrome.storage.local 의 sites 에 두고, 사용자가 연결한 WebDAV 서버 파일(암호화)과 동기화.
//                   서버 모드에서는 storage.sync 를 건드리지 않는다 (브라우저 저장을 쓰는 다른 PC 목록 보호).
// chrome.storage.local: { mode: "server", webdav: { url, username, password }, sites, server: { baseEtag, dirty, lastSync, error } }

const PREFIX = "site:";

export async function getMode() {
  const { mode } = await chrome.storage.local.get("mode");
  return mode === "server" ? "server" : "browser";
}

export async function getSites() {
  if ((await getMode()) === "server") {
    const { sites } = await chrome.storage.local.get("sites");
    return sites || {};
  }
  return getBrowserSites();
}

export async function getBrowserSites() {
  const all = await chrome.storage.sync.get(null);
  const sites = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(PREFIX)) sites[k.slice(PREFIX.length)] = { copy: !!v.c, strong: !!v.s };
  }
  return sites; // { "example.com": { copy: true, strong: false } }
}

// 두 모드를 모두 끈 사이트는 background 에서 removeSite 로 목록에서 뺀다.
// 서버 모드면 dirty(동기화 필요)로 표시된다
export async function saveSite(host, conf) {
  if ((await getMode()) === "server") return changeServerSites((s) => (s[host] = { copy: !!conf.copy, strong: !!conf.strong }));
  await chrome.storage.sync.set({ [PREFIX + host]: { c: +conf.copy, s: +conf.strong } });
  return false;
}

export async function removeSite(host) {
  if ((await getMode()) === "server") return changeServerSites((s) => delete s[host]);
  await chrome.storage.sync.remove(PREFIX + host);
  return false;
}

async function changeServerSites(fn) {
  const { sites = {}, server = {} } = await chrome.storage.local.get(["sites", "server"]);
  fn(sites);
  await chrome.storage.local.set({ sites, server: { ...server, dirty: true } });
  return true;
}

// 브라우저 저장의 목록을 통째로 바꾼다 (서버 → 브라우저 저장으로 전환할 때)
export async function replaceBrowserSites(sites) {
  const old = Object.keys(await getBrowserSites()).filter((h) => !sites[h]);
  if (old.length) await chrome.storage.sync.remove(old.map((h) => PREFIX + h));
  const items = {};
  for (const [h, c] of Object.entries(sites)) items[PREFIX + h] = { c: +c.copy, s: +c.strong };
  if (Object.keys(items).length) await chrome.storage.sync.set(items);
}
