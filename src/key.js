// 서버 동기화 키와 파일 이름 — 둘 다 사용자의 WebDAV 아이디·비밀번호에서 만든다.
// 다른 PC 에서도 같은 아이디·비밀번호만 넣으면 같은 파일을 찾아 열 수 있다.

// cfg: { url, username, password }
export const hasCredentials = (cfg) => !!(cfg?.username && cfg?.password);

// Basic 인증 아이디에는 ":" 가 들어갈 수 없어 "아이디:비밀번호" 는 겹치지 않는다
export function credentialSecret(cfg) {
  return `basic:${cfg.username}:${cfg.password}`;
}

// 설정 파일 이름: 아이디·비밀번호에서 PBKDF2(600k)로 만든 32자리 16진수.
// 비밀번호가 서버 로그·폴더 목록에 드러나지 않고, TapCode 와 salt 가 달라 같은 폴더·같은 계정이어도 파일이 겹치지 않는다.
const fileNames = new Map(); // 서비스 워커가 떠 있는 동안 메모리에만 캐시

export async function credentialFileName(cfg) {
  const material = `${cfg.username}:${cfg.password}`;
  if (fileNames.has(material)) return fileNames.get(material);
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(material), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode("dragon:webdav-file-name:v2"), iterations: 600000 },
    base,
    128
  );
  const name = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  fileNames.set(material, name);
  return name;
}
