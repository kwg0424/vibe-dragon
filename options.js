const $ = (id) => document.getElementById(id);
let sites = {};

function showMessage(text, isError) {
  const m = $("message");
  m.textContent = text;
  m.classList.toggle("error", !!isError);
  m.hidden = !text;
}

function checkbox(host, mode) {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = !!sites[host][mode];
  input.setAttribute("aria-label", `${host} ${mode === "copy" ? "우클릭 · 복사" : "강력 모드"}`);
  input.onchange = async () => {
    const res = await chrome.runtime.sendMessage({ type: "set", host, mode, value: input.checked });
    sites = res.sites;
    if (!sites[host]) render(); // 둘 다 끄면 목록에서 빠짐
  };
  return input;
}

function render() {
  const q = $("filter").value.trim().toLowerCase();
  const hosts = Object.keys(sites).sort();
  const shown = hosts.filter((h) => h.includes(q));
  const tbody = $("rows");
  tbody.textContent = "";

  for (const host of shown) {
    const tr = document.createElement("tr");

    const tdHost = document.createElement("td");
    tdHost.className = "col-host";
    tdHost.textContent = host;
    tdHost.title = host;

    const tdCopy = document.createElement("td");
    tdCopy.className = "col-check";
    tdCopy.appendChild(checkbox(host, "copy"));

    const tdStrong = document.createElement("td");
    tdStrong.className = "col-check";
    tdStrong.appendChild(checkbox(host, "strong"));

    const tdDel = document.createElement("td");
    tdDel.className = "col-del";
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "삭제";
    del.onclick = async () => {
      if (!confirm(`${host} 을(를) 목록에서 삭제할까요?`)) return;
      const res = await chrome.runtime.sendMessage({ type: "remove", host });
      sites = res.sites;
      render();
    };
    tdDel.appendChild(del);

    tr.append(tdHost, tdCopy, tdStrong, tdDel);
    tbody.appendChild(tr);
  }

  $("count").textContent = q ? `${shown.length} / ${hosts.length}개` : `${hosts.length}개`;
  $("empty").hidden = hosts.length > 0;
}

async function load() {
  const res = await chrome.runtime.sendMessage({ type: "get", host: "" });
  sites = res.sites;
  render();
}

$("add-form").onsubmit = async (e) => {
  e.preventDefault();
  const value = $("add-input").value;
  if (!value.trim()) return;
  const res = await chrome.runtime.sendMessage({ type: "add", host: value });
  sites = res.sites;
  if (res.error) {
    showMessage(res.error, true);
  } else {
    showMessage(`${res.host} 을(를) 추가했습니다. (우클릭 · 복사 켜짐)`);
    $("add-input").value = "";
    $("filter").value = "";
  }
  render();
};

$("filter").oninput = render;

// ---------- 설정 저장 위치 (브라우저 / 서버 WebDAV) ----------

let status = { mode: "browser" };
let connectOpen = false;
let busy = false;
let lastRunEnd = 0; // 방금 끝난 작업의 결과 문구를 뒤따라 오는 저장소 변경 알림이 지우지 않도록

function storageMessage(text, isError) {
  const m = $("storage-message");
  m.textContent = text || "";
  m.classList.toggle("error", !!isError);
  m.hidden = !text;
}

const timeText = (t) => new Date(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

function renderStorage() {
  const server = status.mode === "server";
  $("sub").textContent = server
    ? "서버(WebDAV) 동기화로 다른 PC와 공유됩니다."
    : "브라우저 계정 동기화로 다른 PC와 공유됩니다.";
  $("storage-browser").hidden = server || connectOpen;
  $("storage-server").hidden = !server || connectOpen;
  $("form-connect").hidden = !connectOpen;
  if (server) {
    $("server-url").textContent = status.username ? `${status.url} · ${status.username}` : status.url;
    const state = $("server-state");
    state.textContent = status.error
      ? status.autoPaused
        ? `자동 동기화 실패: ${status.error} — "동기화"가 성공할 때까지 자동 동기화를 멈춥니다.`
        : status.error
      : status.dirty
        ? "서버에 아직 올리지 않은 변경이 있습니다."
        : status.lastSync ? `마지막 동기화 ${timeText(status.lastSync)}` : "";
    state.classList.toggle("error", !!status.error);
    $("dirty-dot").hidden = !status.dirty && !status.error;
  }
  for (const b of document.querySelectorAll("#storage button")) b.disabled = busy;
}

async function loadStatus() {
  status = await chrome.runtime.sendMessage({ type: "status" });
  renderStorage();
}

const DONE = {
  created: "서버에 새 설정 파일을 만들었습니다",
  pushed: "서버에 저장했습니다",
  merged: "양쪽 변경을 합쳐 서버에 저장했습니다",
  pulled: "서버에서 목록을 가져왔습니다",
  unchanged: "이미 최신 상태입니다"
};

async function run(msg) {
  busy = true;
  renderStorage();
  storageMessage("");
  try {
    const res = await chrome.runtime.sendMessage(msg);
    if (res.error) storageMessage(res.error, true);
    else if (DONE[res.action]) storageMessage(DONE[res.action]);
    return res;
  } finally {
    busy = false;
    lastRunEnd = Date.now();
    await loadStatus();
    await load();
  }
}

function openConnect() {
  const f = $("form-connect").elements;
  const server = status.mode === "server";
  f.url.value = server ? status.url : "";
  f.username.value = server ? status.username : "";
  // 저장된 비밀번호는 받지도 표시하지도 않는다. 비워 두면 그대로 쓴다
  f.password.value = "";
  f.password.required = !(server && status.hasPassword);
  f.password.placeholder = server && status.hasPassword ? "변경하지 않으려면 비워 두세요" : "";
  connectOpen = true;
  storageMessage("");
  renderStorage();
  f.url.focus();
}

$("btn-open-connect").onclick = openConnect;
$("btn-edit-connect").onclick = openConnect;
$("connect-cancel").onclick = () => {
  connectOpen = false;
  storageMessage("");
  renderStorage();
};

// 서버와 이 기기 목록이 다를 때 어느 쪽을 쓸지 → "remote" | "local" | null(취소)
function askConflict({ server, local }) {
  const dlg = $("conflict");
  $("conflict-text").textContent = `서버에 다른 사이트 목록이 있습니다.
서버 ${server}개 · 이 기기 ${local}개
어느 쪽을 쓸까요?`;
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue || null), { once: true });
    dlg.returnValue = "";
    dlg.showModal();
  });
}
for (const btn of document.querySelectorAll("#conflict button")) btn.onclick = () => $("conflict").close(btn.value);

$("form-connect").onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const msg = { type: "connect", url: f.url.value, username: f.username.value, password: f.password.value };
  let res = await run(msg);
  if (res.ask) {
    const choice = await askConflict(res.ask);
    if (!choice) return storageMessage("연결을 취소했습니다");
    res = await run({ ...msg, choice });
  }
  if (!res.error) {
    f.password.value = "";
    connectOpen = false;
    renderStorage();
  }
};

$("btn-sync").onclick = () => run({ type: "sync" });

$("btn-disconnect").onclick = async () => {
  if (!confirm("브라우저 저장으로 전환할까요?\n지금 목록을 이 브라우저에 저장하고 서버 연결을 끊습니다. 서버의 파일은 그대로 남습니다.")) return;
  await run({ type: "disconnect" });
  storageMessage("브라우저 저장으로 전환했습니다");
};

// 팝업이나 다른 PC에서 바뀌면 목록과 상태 갱신
chrome.storage.onChanged.addListener((_changes, area) => {
  if (busy) return;
  if (area === "sync" && status.mode === "browser") load();
  if (area === "local") {
    // 백그라운드 자동 동기화로 상태가 바뀌면 지난 결과 문구는 지운다
    if (Date.now() - lastRunEnd > 1500) storageMessage("");
    load();
    loadStatus();
  }
});

load();
loadStatus();
