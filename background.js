// DragOn 백그라운드: 사이트별 설정을 저장하고, 페이지가 로드되면 해제 스크립트를 주입한다.
// 외부 통신은 사용자가 서버(WebDAV) 동기화를 연결했을 때 그 서버로만 한다.
import { getSites, getBrowserSites, saveSite, removeSite, replaceBrowserSites } from "./src/store.js";
import { sync, peekRemote, sameSites } from "./src/sync.js";
import { folderUrl, assertSecureUrl } from "./src/webdav.js";

const MODES = {
  copy: "inject/copy.js",     // 기본: 우클릭 + 선택 + 복사 허용
  strong: "inject/strong.js"  // 강력: 키/마우스 이벤트 차단까지 무력화
};

// 목록 변경과 서버 동기화는 한 줄로 세워 처리한다 (동기화 도중 바뀐 내용을 덮어쓰지 않도록)
let queue = Promise.resolve();
const serial = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

// "https://www.Example.com/path" 나 "example.com" 을 "www.example.com" / "example.com" 형태로
function normalizeHost(input) {
  const s = String(input || "").trim().toLowerCase();
  if (!s) return null;
  try {
    const host = new URL(/^[a-z]+:\/\//.test(s) ? s : "http://" + s).hostname;
    return /^[a-z0-9.-]+$/.test(host) && host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

// 1.0.0 은 storage.local 에 { sites: {...} } 로 저장했으므로 한 번만 sync 로 옮긴다.
// (1.4.0 부터 서버 모드도 storage.local.sites 를 쓰므로 mode 가 없을 때만 옮긴다)
chrome.runtime.onInstalled.addListener(async () => {
  const { sites, mode } = await chrome.storage.local.get(["sites", "mode"]);
  if (sites && !mode) {
    const synced = await getBrowserSites();
    for (const [host, conf] of Object.entries(sites)) {
      if (!synced[host]) await saveSite(host, conf);
    }
    await chrome.storage.local.remove("sites");
  }
  // 1.4.1 부터 두 모드를 모두 끈 사이트는 목록에서 빠진다 → 예전에 남겨 둔 것도 정리
  serial(async () => {
    for (const [host, conf] of Object.entries(await getSites())) {
      if (!conf.copy && !conf.strong) await removeSite(host);
    }
  });
});

// ---------- 서버(WebDAV) 동기화 ----------

// 사이트를 추가·변경·삭제하면 바로 서버에 저장한다 (queueSync). 실패하면 "동기화 필요"(빨간 점)로 남고
// 옵션의 "동기화" 버튼이나 다음 변경 때 다시 올린다. 연결할 때도 바로 한 번 동기화한다.
// 다른 PC 변경은 동기화 버튼, 다음 저장, 또는 마지막 동기화가 하루를 넘었을 때의 자동 동기화(autoSync)로 받는다.
// 양쪽이 모두 바뀌었으면 묻지 않고 합친다 (sync.js).
// auto: 자동 동기화가 실패하면 autoPaused 로 표시 → 수동 동기화가 성공할 때까지 자동으로 다시 시도하지 않는다
async function runSync(auto = false) {
  const { mode, webdav, sites = {}, server = {} } = await chrome.storage.local.get(["mode", "webdav", "sites", "server"]);
  if (mode !== "server" || !webdav) return { action: "none" };
  try {
    const r = await sync(webdav, { sites, baseEtag: server.baseEtag ?? null, dirty: !!server.dirty });
    await chrome.storage.local.set({ sites: r.sites, server: { baseEtag: r.baseEtag, dirty: false, lastSync: Date.now() } });
    return { action: r.action };
  } catch (e) {
    await chrome.storage.local.set({ server: { ...server, error: e.message, ...(auto && { autoPaused: true }) } });
    return { error: e.message };
  }
}

// 목록을 바꾼 직후 서버에 저장. 연달아 바꾸면 아직 시작 안 한 동기화 하나로 묶는다
let syncQueued = false;
function queueSync() {
  if (syncQueued) return;
  syncQueued = true;
  serial(() => {
    syncQueued = false;
    return runSync();
  });
}

const AUTO_SYNC_AFTER = 24 * 60 * 60 * 1000; // 마지막 동기화 후 하루
const AUTO_CHECK_EVERY = 10 * 60 * 1000; // 페이지를 열 때마다 저장소를 읽지 않도록 (서비스 워커가 떠 있는 동안)
let lastAutoCheck = 0;

// 브라우저 시작·페이지 로드 때 확인. alarms 권한 없이 사용자가 브라우저를 쓰는 동안에만 돈다
function autoSync() {
  if (Date.now() - lastAutoCheck < AUTO_CHECK_EVERY) return;
  lastAutoCheck = Date.now();
  serial(async () => {
    const { mode, webdav, server = {} } = await chrome.storage.local.get(["mode", "webdav", "server"]);
    if (mode !== "server" || !webdav || server.autoPaused) return;
    if (server.lastSync && Date.now() - server.lastSync < AUTO_SYNC_AFTER) return;
    await runSync(true);
  });
}

chrome.runtime.onStartup.addListener(autoSync);


// password 를 비워 보내면 저장된 비밀번호를 그대로 쓴다 (옵션 페이지에 비밀번호를 다시 보내지 않으므로)
// 새로 연결(다시 연결 포함)할 때 서버에 이 기기와 다른 목록이 있으면 TapCode 처럼 어느 쪽을 쓸지 묻는다:
// choice 없이 오면 { ask: { server, local } } 을 돌려주고, 옵션 페이지가 choice("remote" | "local")를 붙여 다시 보낸다
async function connect({ url, username, password, choice }) {
  url = folderUrl(String(url || ""));
  username = String(username || "").trim();
  password = String(password || "");
  try {
    assertSecureUrl(`${url}/`);
  } catch (e) {
    return { error: e.message };
  }
  if (!username) return { error: "아이디를 입력하세요" };
  if (username.includes(":")) return { error: "아이디에는 : 를 쓸 수 없습니다" };

  const state = await chrome.storage.local.get(["mode", "webdav", "sites", "server"]);
  password ||= (state.mode === "server" && state.webdav?.password) || "";
  if (!password) return { error: "비밀번호를 입력하세요" };
  const cfg = { url, username, password };
  // 같은 서버 파일에 다시 연결(접속 정보 변경 화면에서 그대로 저장)이면 지금 상태 그대로 동기화
  const same =
    state.mode === "server" && state.webdav?.url === url && state.webdav?.username === username && state.webdav?.password === password;
  const sites = state.mode === "server" ? state.sites || {} : await getBrowserSites();
  let local = same ? { sites, baseEtag: state.server?.baseEtag ?? null, dirty: !!state.server?.dirty } : { sites, baseEtag: null, dirty: true };
  let action = null;
  try {
    if (!same) {
      const remote = await peekRemote(cfg);
      if (remote.sites && !sameSites(remote.sites, sites)) {
        const count = (o) => Object.keys(o).length;
        // 한쪽이 비어 있으면 묻지 않는다: 이 기기가 비었으면 서버 목록을, 서버가 비었으면 이 기기 목록을 쓴다
        if (!count(sites)) choice = "remote";
        else if (!count(remote.sites)) choice = "local";
        if (!choice) return { ask: { server: count(remote.sites), local: count(sites) } };
        // 서버 목록 사용: 서버 파일을 기준으로 가져온다 / 이 기기 목록 올리기: 서버 파일을 덮어쓴다
        if (choice === "remote") [local, action] = [{ sites: remote.sites, baseEtag: remote.etag, dirty: false }, "pulled"];
        else local = { sites, baseEtag: remote.etag, dirty: true };
      }
    }
    const r = await sync(cfg, local);
    await chrome.storage.local.set({
      mode: "server",
      webdav: cfg,
      sites: r.sites,
      server: { baseEtag: r.baseEtag, dirty: false, lastSync: Date.now() }
    });
    return { action: action || r.action };
  } catch (e) {
    return { error: e.message };
  }
}

// 브라우저 저장으로 전환: 지금 목록을 브라우저 저장(storage.sync)으로 옮긴다. 서버 파일은 그대로 둔다.
async function disconnect() {
  const { mode, sites = {} } = await chrome.storage.local.get(["mode", "sites"]);
  if (mode !== "server") return {};
  await replaceBrowserSites(sites);
  await chrome.storage.local.remove(["mode", "webdav", "sites", "server"]);
  return {};
}

async function status() {
  const { mode, webdav, server = {} } = await chrome.storage.local.get(["mode", "webdav", "server"]);
  if (mode !== "server") return { mode: "browser" };
  // 비밀번호는 옵션 페이지로 보내지 않는다 (저장돼 있는지만)
  return {
    mode,
    url: webdav?.url,
    username: webdav?.username || "",
    hasPassword: !!webdav?.password,
    dirty: !!server.dirty,
    lastSync: server.lastSync || null,
    error: server.error || null,
    autoPaused: !!server.autoPaused
  };
}

// ---------- 주입 ----------

function hostOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname : null;
  } catch {
    return null;
  }
}

async function inject(tabId, mode) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: [MODES[mode]],
      world: "MAIN"
    });
  } catch {
    // 주입할 수 없는 페이지(스토어, 내부 페이지 등)는 무시
  }
}

async function applyToTab(tabId, url) {
  const host = hostOf(url);
  if (!host) return;
  const conf = (await getSites())[host];
  if (!conf) return;
  if (conf.copy) await inject(tabId, "copy");
  if (conf.strong) await inject(tabId, "strong");
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" && tab.url) {
    applyToTab(tabId, tab.url);
    autoSync();
  }
});

// ---------- 팝업·옵션 페이지 요청 ----------

async function handle(msg) {
  switch (msg.type) {
    case "get": {
      const sites = await getSites();
      return { conf: sites[msg.host] || { copy: false, strong: false }, sites };
    }

    case "set": {
      // 켤 때는 새로고침 없이 바로 적용
      if (msg.value && msg.tabId != null) inject(msg.tabId, msg.mode);
      return serial(async () => {
        const sites = await getSites();
        const conf = { ...(sites[msg.host] || { copy: false, strong: false }), [msg.mode]: msg.value };
        // 우클릭·복사와 강력 모드를 둘 다 끄면 목록에서 뺀다
        if (conf.copy || conf.strong) {
          sites[msg.host] = conf;
          if (await saveSite(msg.host, conf)) queueSync(); // 서버 모드면 true
        } else {
          delete sites[msg.host];
          if (await removeSite(msg.host)) queueSync();
        }
        return { conf, sites };
      });
    }

    case "add":
      return serial(async () => {
        const sites = await getSites();
        const host = normalizeHost(msg.host);
        if (!host) return { error: "올바른 사이트 주소가 아닙니다.", sites };
        if (sites[host]) return { error: `${host} 은(는) 이미 목록에 있습니다.`, sites };
        sites[host] = { copy: true, strong: false };
        if (await saveSite(host, sites[host])) queueSync();
        return { host, sites };
      });

    case "remove":
      return serial(async () => {
        const sites = await getSites();
        delete sites[msg.host];
        if (await removeSite(msg.host)) queueSync();
        return { sites };
      });

    case "status":
      return status();

    case "sync":
      return serial(runSync);

    case "connect":
      return serial(() => connect(msg));

    case "disconnect":
      return serial(disconnect);
  }
  return {};
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse, (e) => sendResponse({ error: e.message }));
  return true; // 비동기 응답
});
