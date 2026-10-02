// node test/run.mjs — 서버(WebDAV) 동기화 로직 테스트 (브라우저 없이)
// 테스트 안에 ETag/If-Match 와 Basic(아이디·비밀번호) 인증을 지원하는 최소 WebDAV 서버를 띄운다.
import http from "node:http";
import assert from "node:assert/strict";
import { sync, mergeSites, sameSites } from "../src/sync.js";
import { credentialFileName, credentialSecret } from "../src/key.js";
import { decryptVault } from "../src/crypto.js";

const files = new Map(); // "아이디 경로" → { body, etag }
let etagSeq = 0;
const USERS = { alice: "pw-A", bob: "비번B" }; // 한글 비밀번호(UTF-8)도 되는지
const log = [];

const server = http.createServer(async (req, res) => {
  log.push(`${req.method} ${req.url}`); // 서버 접근 로그에 남는 부분
  const b64 = /^Basic (.+)$/.exec(req.headers.authorization || "")?.[1];
  const [user, ...rest] = b64 ? Buffer.from(b64, "base64").toString("utf8").split(":") : [];
  if (!user || USERS[user] !== rest.join(":")) return res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' }).end();
  const key = `${user} ${req.url}`;
  const cur = files.get(key);
  if (req.method === "GET" || req.method === "HEAD") {
    if (!cur) return res.writeHead(404).end();
    return res.writeHead(200, { ETag: cur.etag, "Content-Type": "application/json" }).end(req.method === "GET" ? cur.body : undefined);
  }
  if (req.method === "MKCOL") return res.writeHead(201).end();
  if (req.method === "PUT") {
    let body = "";
    for await (const c of req) body += c;
    if (req.headers["if-none-match"] === "*" && cur) return res.writeHead(412).end();
    if (req.headers["if-match"] && req.headers["if-match"] !== cur?.etag) return res.writeHead(412).end();
    const etag = `"${++etagSeq}"`;
    files.set(key, { body, etag });
    return res.writeHead(cur ? 204 : 201, { ETag: etag }).end();
  }
  res.writeHead(405).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/setting/dragon`;
const cfgA = { url: BASE, username: "alice", password: "pw-A" };
const cfgB = { url: BASE, username: "bob", password: "비번B" };
const fileKey = async (cfg) => `${cfg.username} /setting/dragon/${await credentialFileName(cfg)}.json`;

// 다른 기기가 서버를 바꾼 것처럼 직접 올리기
async function serverSites(cfg) {
  const f = files.get(await fileKey(cfg));
  return f ? (await decryptVault(JSON.parse(f.body), credentialSecret(cfg))).sites : null;
}

const S = (...hosts) => Object.fromEntries(hosts.map((h) => [h, { copy: true, strong: false }]));
const keys = (sites) => Object.keys(sites).sort().join(",");

let n = 0;
async function test(name, fn) {
  await fn();
  console.log(`  ok  ${name}`);
  n++;
}

// PC1: 처음 연결 → 서버에 파일 생성
let pc1 = { sites: S("a.com", "b.com"), baseEtag: null, dirty: true };
await test("처음 연결 → 새 파일 생성", async () => {
  const r = await sync(cfgA, pc1);
  assert.equal(r.action, "created");
  assert.equal(keys(await serverSites(cfgA)), "a.com,b.com");
  pc1 = { sites: r.sites, baseEtag: r.baseEtag, dirty: false };
});

await test("파일 이름(주소)에 아이디·비밀번호가 드러나지 않고 TapCode 와 다름", async () => {
  const name = await credentialFileName(cfgA);
  assert.match(name, /^[0-9a-f]{32}$/);
  assert.ok(!log.some((l) => l.includes("alice") || l.includes("pw-A")));
  // TapCode 는 같은 계정이라도 salt 가 달라 다른 파일 이름 → 같은 폴더에 둬도 겹치지 않는다
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode("alice:pw-A"), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode("tapcode:webdav-file-name:v2"), iterations: 600000 }, base, 128);
  const tapcode = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  assert.notEqual(name, tapcode);
});

await test("서버 파일은 암호문 (사이트 주소 평문 없음)", async () => {
  const body = [...files.values()][0].body;
  assert.ok(!body.includes("a.com"));
  assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ["ct", "iter", "iv", "kdf", "salt", "title", "v"]);
  assert.match(JSON.parse(body).title, /^DragOn /);
});

await test("변경 없음", async () => {
  const r = await sync(cfgA, pc1);
  assert.equal(r.action, "unchanged");
});

// PC2: 같은 토큰, 브라우저 목록이 비어 있음 → 묻지 않고 가져오기
let pc2;
await test("다른 PC 빈 목록으로 연결 → 가져오기", async () => {
  const r = await sync(cfgA, { sites: {}, baseEtag: null, dirty: true });
  assert.equal(r.action, "pulled");
  assert.equal(keys(r.sites), "a.com,b.com");
  pc2 = { sites: r.sites, baseEtag: r.baseEtag, dirty: false };
});

await test("PC2 변경 → 올리기, PC1 → 받기", async () => {
  pc2 = { ...pc2, sites: { ...pc2.sites, "c.com": { copy: true, strong: true } }, dirty: true };
  const r = await sync(cfgA, pc2);
  assert.equal(r.action, "pushed");
  pc2 = { sites: r.sites, baseEtag: r.baseEtag, dirty: false };
  const r1 = await sync(cfgA, pc1);
  assert.equal(r1.action, "pulled");
  assert.deepEqual(r1.sites["c.com"], { copy: true, strong: true });
  pc1 = { sites: r1.sites, baseEtag: r1.baseEtag, dirty: false };
});

await test("양쪽 변경 → 묻지 않고 합치기 (같은 사이트는 이 기기 설정, 지운 사이트는 다시 생김)", async () => {
  pc2 = { ...pc2, sites: { ...pc2.sites, "from2.com": { copy: true, strong: false } }, dirty: true };
  pc2 = { ...(await sync(cfgA, pc2)), dirty: false };
  const { ["a.com"]: _, ...rest } = pc1.sites; // PC1 은 a.com 삭제, c.com 설정 변경, from1.com 추가
  pc1 = { ...pc1, sites: { ...rest, "c.com": { copy: true, strong: false }, "from1.com": { copy: false, strong: true } }, dirty: true };
  const r = await sync(cfgA, pc1);
  assert.equal(r.action, "merged");
  assert.equal(keys(r.sites), "a.com,b.com,c.com,from1.com,from2.com");
  assert.deepEqual(r.sites["c.com"], { copy: true, strong: false });
  assert.equal(keys(await serverSites(cfgA)), keys(r.sites));
  pc1 = { sites: r.sites, baseEtag: r.baseEtag, dirty: false };
});

await test("한쪽만 바뀌었으면 삭제도 그대로 반영", async () => {
  const { ["a.com"]: _, ...rest } = pc1.sites;
  const r = await sync(cfgA, { ...pc1, sites: rest, dirty: true });
  assert.equal(r.action, "pushed");
  assert.ok(!(await serverSites(cfgA))["a.com"]);
  pc1 = { sites: r.sites, baseEtag: r.baseEtag, dirty: false };
  pc2 = { ...(await sync(cfgA, { ...pc2, dirty: false })), dirty: false };
  assert.equal(keys(pc2.sites), keys(pc1.sites));
});

await test("양쪽이 같은 변경을 했으면 올리지 않음", async () => {
  pc2 = { ...(await sync(cfgA, { ...pc2, sites: { ...pc2.sites, "same.com": { copy: true, strong: false } }, dirty: true })), dirty: false };
  const before = [...files.values()].map((f) => f.etag).join();
  const r = await sync(cfgA, { ...pc1, sites: { ...pc1.sites, "same.com": { copy: true, strong: false } }, dirty: true });
  assert.equal(r.action, "unchanged"); // 두 목록이 이미 같음
  assert.equal([...files.values()].map((f) => f.etag).join(), before);
  pc1 = { sites: r.sites, baseEtag: r.baseEtag, dirty: false };
});

await test("처음 연결: 다른 목록이면 합치기, 같은 목록이면 그대로", async () => {
  const r = await sync(cfgA, { sites: S("new-pc.com"), baseEtag: null, dirty: true });
  assert.equal(r.action, "merged");
  assert.ok(r.sites["new-pc.com"] && r.sites["b.com"]);
  pc1 = { ...(await sync(cfgA, { ...pc1, dirty: false })), dirty: false };
  const r2 = await sync(cfgA, { sites: pc1.sites, baseEtag: null, dirty: true });
  assert.equal(r2.action, "unchanged");
});

await test("서버 파일의 '둘 다 꺼진' 사이트는 받지 않음", async () => {
  const name = await fileKey(cfgA);
  const { encryptVault } = await import("../src/crypto.js");
  const blob = await encryptVault({ sites: { "on.com": { copy: true, strong: false }, "off.com": { copy: false, strong: false } } }, credentialSecret(cfgA));
  files.set(name, { body: JSON.stringify(blob), etag: `"${++etagSeq}"` });
  const r = await sync(cfgA, { ...pc1, dirty: false });
  assert.equal(keys(r.sites), "on.com");
  pc1 = { sites: r.sites, baseEtag: r.baseEtag, dirty: false };
});

await test("손상된 서버 파일 → 이 기기 목록으로 다시 씀", async () => {
  const name = await fileKey(cfgA);
  const bad = JSON.parse(files.get(name).body);
  bad.ct = bad.ct.slice(0, -4) + "AAAA";
  files.set(name, { body: JSON.stringify(bad), etag: `"${++etagSeq}"` });
  const r = await sync(cfgA, { ...pc1, sites: S("keep.com"), dirty: true });
  assert.equal(r.action, "pushed");
  assert.equal(keys(await serverSites(cfgA)), "keep.com");
  pc1 = { sites: r.sites, baseEtag: r.baseEtag, dirty: false };
});

await test("계정이 다르면 다른 파일 (서로 안 섞임, 한글 비밀번호)", async () => {
  const r = await sync(cfgB, { sites: S("b-only.com"), baseEtag: null, dirty: true });
  assert.equal(r.action, "created");
  assert.equal(keys(await serverSites(cfgA)), "keep.com");
  assert.equal(keys(await serverSites(cfgB)), "b-only.com");
});

await test("틀린 비밀번호 → 인증 실패", async () => {
  await assert.rejects(sync({ ...cfgA, password: "nope" }, { sites: {}, baseEtag: null, dirty: true }), /인증 실패: 아이디 또는 비밀번호/);
});

await test("https 가 아니면 비밀번호를 보내지 않음 / 예전 토큰 설정은 다시 입력 요구", async () => {
  const before = log.length;
  await assert.rejects(sync({ ...cfgA, url: "http://example.com/dav" }, pc1), /https:\/\//);
  await assert.rejects(sync({ url: BASE, token: "tok-A" }, pc1), /다시 입력/);
  assert.equal(log.length, before); // 서버로 요청이 나가지 않음
});

await test("서버 꺼짐 → 연결 실패", async () => {
  await assert.rejects(sync({ ...cfgA, url: "http://127.0.0.1:1/x" }, pc1), /연결할 수 없습니다/);
});

await test("mergeSites / sameSites", async () => {
  assert.deepEqual(mergeSites(S("a.com"), { "a.com": { copy: false, strong: true } }), { "a.com": { copy: false, strong: true } });
  assert.ok(sameSites(S("a.com", "b.com"), S("b.com", "a.com")));
  assert.ok(!sameSites(S("a.com"), { "a.com": { copy: true, strong: true } }));
});

server.close();
console.log(`\n${n}개 통과`);
