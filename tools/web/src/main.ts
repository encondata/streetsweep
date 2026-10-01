import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";

export default mount(App, { target: document.getElementById("app")! });

// For looking inside from the browser console when something misbehaves.
import { ws } from "./lib/workspace.svelte";
import { store } from "./lib/store.svelte";
(window as unknown as { streetsweep: unknown }).streetsweep = { ws, store };
