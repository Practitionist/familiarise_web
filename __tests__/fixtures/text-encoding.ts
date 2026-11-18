import { TextDecoder, TextEncoder } from "node:util";

// jsdom lacks these; react-dom/server reads TextEncoder when it loads.
Object.assign(globalThis, { TextEncoder, TextDecoder });
