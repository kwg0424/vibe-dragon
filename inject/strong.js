// 강력 모드: 마우스/키보드 이벤트로 막는 사이트까지 무력화
// (사이트의 일부 버튼·단축키가 동작하지 않을 수 있음)
(() => {
  if (window.__dragonStrong) return;
  window.__dragonStrong = true;

  const style = document.createElement("style");
  style.textContent = `
    *, *::before, *::after {
      -webkit-user-select: text !important;
      user-select: text !important;
      -webkit-user-drag: auto !important;
    }`;
  (document.head || document.documentElement).appendChild(style);

  const types = [
    "contextmenu", "copy", "cut", "paste", "select", "selectstart",
    "drag", "dragstart", "mousedown", "mouseup", "keydown", "keyup"
  ];
  for (const type of types) {
    document.addEventListener(type, (e) => e.stopPropagation(), true);
  }
})();
