import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { DevCards } from "./DevCards.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

// One screen and one dev page, so the path is the whole router (US-011).
const page = window.location.pathname === "/dev/cards" ? <DevCards /> : <App />;

createRoot(container).render(<React.StrictMode>{page}</React.StrictMode>);
