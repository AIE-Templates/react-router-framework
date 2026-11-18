import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import sirv from "sirv";

const clientDir = join(import.meta.dirname, "build/client");
const single = existsSync(join(clientDir, "__spa-fallback.html")) ? "__spa-fallback.html" : "index.html";
const server = createServer(sirv(clientDir, { single, gzip: true, brotli: true }));
server.listen(Number(process.env.PORT || 3000), process.env.HOST || "0.0.0.0");
