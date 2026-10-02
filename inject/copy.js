// 기본 모드: 우클릭, 텍스트 선택, 드래그, 복사 차단 해제
(() => {
  if (window.__dragonCopy) return;
  window.__dragonCopy = true;

  const style = document.createElement("style");
  style.textContent = `
    *, *::before, *::after {
      -webkit-user-select: text !important;
      user-select: text !important;
    }`;
  (document.head || document.documentElement).appendChild(style);

  const clearHandlers = () => {
    const props = ["oncontextmenu", "onselectstart", "ondragstart", "onmousedown", "oncopy", "oncut", "onpaste"];
    for (const el of [window, document, document.body, document.documentElement]) {
      if (!el) continue;
      for (const p of props) {
        try { el[p] = null; } catch {}
      }
    }
    for (const el of document.querySelectorAll("[oncontextmenu],[onselectstart],[ondragstart],[oncopy]")) {
      for (const p of props) el.removeAttribute(p);
    }
  };
  clearHandlers();
  setTimeout(clearHandlers, 2000); // 늦게 다시 거는 사이트 대응

  // 캡처 단계 최상단에서 전파를 끊어 페이지의 차단 핸들러가 실행되지 않게 한다.
  // 브라우저 기본 동작(메뉴 표시, 복사)은 그대로 일어난다.
  for (const type of ["contextmenu", "copy", "cut", "paste", "selectstart", "dragstart"]) {
    window.addEventListener(type, (e) => e.stopImmediatePropagation(), true);
  }
})();
