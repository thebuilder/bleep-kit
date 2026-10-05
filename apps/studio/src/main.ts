// Placeholder: renders a heading and whether the page is cross-origin isolated (SharedArrayBuffer needs it).
const app = document.querySelector("#app");
if (app) {
  const title = document.createElement("h1");
  title.textContent = "Bleepkit Studio";
  const isolated = document.createElement("p");
  isolated.textContent = `cross-origin isolated: ${globalThis.crossOriginIsolated ? "yes" : "no"}`;
  app.replaceChildren(title, isolated);
}
