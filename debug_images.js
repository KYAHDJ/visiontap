// VisionTap debug script - run on server to see what images the page has
// Usage: node debug_images.js

const http = require("http");
const url = require("url");

const SCANNER = "http://127.0.0.1:5566";

function fetchJSON(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, SCANNER);
    http.get(u, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch(e) { resolve({ raw: d }); }
      });
    }).on("error", reject);
  });
}

async function main() {
  const health = await fetchJSON("/health");
  console.log("Scanner:", health);

  // Send a test detect to see what error we get
  const testResult = await fetchJSON("/stats");
  console.log("Stats:", JSON.stringify(testResult, null, 2));
}

main().catch(console.error);
