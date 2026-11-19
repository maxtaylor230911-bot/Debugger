// ⚠️ INTENTIONALLY VULNERABLE DEMO APP — DO NOT DEPLOY.
// It exists so the 0security scan has real bugs to find.
// Replace the app/ folder with your own code when you're ready.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { exec } = require("node:child_process");

// Bug 1: hard-coded credential (fake value, for the demo only).
const ADMIN_TOKEN = "demo-admin-token-changeme";

const PUBLIC_DIR = path.join(__dirname, "public");

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  // Bug 2: command injection — `host` goes straight into a shell.
  if (url.pathname === "/ping") {
    const host = url.searchParams.get("host") || "127.0.0.1";
    exec(`ping -c 1 ${host}`, (err, stdout) => {
      res.end(err ? "ping failed" : stdout);
    });
    return;
  }

  // Bug 3: path traversal — `?file=../../etc/passwd` escapes PUBLIC_DIR.
  if (url.pathname === "/files") {
    const file = url.searchParams.get("file") || "index.html";
    fs.readFile(path.join(PUBLIC_DIR, file), (err, data) => {
      if (err) {
        res.statusCode = 404;
        return res.end("not found");
      }
      res.end(data);
    });
    return;
  }

  // Bug 4: non-constant-time token comparison, token accepted in the URL.
  if (url.pathname === "/admin") {
    if (url.searchParams.get("token") == ADMIN_TOKEN) {
      res.end("welcome, admin");
    } else {
      res.statusCode = 403;
      res.end("forbidden");
    }
    return;
  }

  res.end("Debugger demo app. Try /ping, /files or /admin.");
});

server.listen(3000, () => console.log("listening on http://localhost:3000"));
