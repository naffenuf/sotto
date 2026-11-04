import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { DevCards } from "./DevCards.js";
import { Soundboard } from "./Soundboard.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

// One screen and two dev pages, so the path is the whole router (US-011).
const path = window.location.pathname;
const page = path === "/dev/cards" ? <DevCards /> : path === "/dev/soundboard" ? <Soundboard /> : <App />;

createRoot(container).render(<React.StrictMode>{page}</React.StrictMode>);
