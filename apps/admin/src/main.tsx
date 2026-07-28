import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { registerControlledServiceWorker } from "./pwa-update";
import "./styles.css";

registerControlledServiceWorker();

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>
);
