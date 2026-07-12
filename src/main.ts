import "./styles.css";
import { RappHeirApp } from "./app";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Application root is missing");

void new RappHeirApp(root).start().catch((error: unknown) => {
  const main = document.createElement("main");
  main.className = "fatal";
  const heading = document.createElement("h1");
  heading.textContent = "Rapp Heir could not start";
  const detail = document.createElement("p");
  detail.textContent = error instanceof Error ? error.message : "Unknown local startup error";
  main.append(heading, detail);
  root.replaceChildren(main);
});

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL,
    });
  });
}
