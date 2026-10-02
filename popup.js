const $ = (id) => document.getElementById(id);
let tab, host;

function showConf(conf) {
  $("copy").checked = !!conf.copy;
  $("strong").checked = !!conf.strong;
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const u = new URL(tab.url);
    if (/^https?:$/.test(u.protocol)) host = u.hostname;
  } catch {}

  $("manage").onclick = () => {
    chrome.runtime.openOptionsPage();
    window.close();
  };
  showSyncState();

  if (!host) {
    $("controls").hidden = true;
    $("unsupported").hidden = false;
    return;
  }

  $("host").textContent = host;
  $("host").title = host;
  $("host").hidden = false;
  const res = await chrome.runtime.sendMessage({ type: "get", host });
  showConf(res.conf);

  for (const mode of ["copy", "strong"]) {
    $(mode).onchange = async (e) => {
      await chrome.runtime.sendMessage({
        type: "set", host, mode, value: e.target.checked, tabId: tab.id
      });
      if (!e.target.checked) $("reload").hidden = false;
    };
  }

  $("reload").onclick = () => {
    chrome.tabs.reload(tab.id);
    window.close();
  };
}

// 사이트를 바꾸면 백그라운드가 바로 서버에 저장한다. 저장(동기화)이 실패했을 때만 원인을 표시
async function showSyncState() {
  const s = await chrome.runtime.sendMessage({ type: "status" });
  const msg = $("sync-msg");
  msg.textContent = s.mode === "server" && s.error ? `서버 저장 실패: ${s.error} (설정에서 동기화)` : "";
  msg.hidden = !msg.textContent;
}

// 옵션 페이지나 다른 PC에서 바뀌면 화면 갱신
chrome.storage.onChanged.addListener(async (_changes, area) => {
  if (area === "local") showSyncState();
  if (!host) return;
  const res = await chrome.runtime.sendMessage({ type: "get", host });
  showConf(res.conf);
});

init();
