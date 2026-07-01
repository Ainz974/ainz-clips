import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const r = require("../src/resolver.js");
// Instagram reel — login-walled, no cookies passed → should detect auth
const url = "https://www.instagram.com/reel/DUcxTGSETCs/";
const res = await r.resolve(url, (l) => console.log("  ", l), {});
console.log("\nKIND:", res.kind);
if (res.kind === "auth") console.log("✅ auth detected →", res.site, "| loginUrl:", res.loginUrl);
else console.log("sources:", res.sources.length, "(expected auth prompt)");
process.exit(0);
