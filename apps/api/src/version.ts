import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageManifest = require("../package.json") as { version: string };

export const API_VERSION = packageManifest.version;
