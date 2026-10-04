"use strict";
// Regenerates web/js/deployments.js from deployments/*.json so the static pages know the contract addresses.
// Run automatically by deploy.js; run it by hand (`npm run web:config`) after editing a deployments file.
const fs = require("fs");
const path = require("path");
const { ROOT, loadDeployment } = require("./lib/chain");

function build() {
  const out = {};
  for (const key of ["arcTestnet", "arcMainnet", "local"]) {
    const d = loadDeployment(key === "local" ? "localhost" : key);
    out[key] = { contract: d ? d.address : "", deployBlock: d ? Number(d.blockNumber) : 0 };
  }
  return out;
}

function render(obj) {
  // The web tests and the pages expect exactly this shape: a window.ArcInvoiceDeployments assignment, plus a Node shim.
  return (
    "// Written by scripts/write-web-config.js from deployments/*.json (the deploy script runs it). An empty contract means\n" +
    "// \"not deployed on this network yet\". Safe to edit by hand.\n" +
    "if (typeof window === 'undefined') { var window = {}; }\n" +
    "window.ArcInvoiceDeployments = " + JSON.stringify(obj, null, 2) + ";\n" +
    "if (typeof module === 'object' && module.exports) module.exports = window.ArcInvoiceDeployments;\n"
  );
}

function main() {
  const target = path.join(ROOT, "web", "js", "deployments.js");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, render(build()));
  console.log("wrote", path.relative(ROOT, target));
}

if (require.main === module) main();
module.exports = { build, render, main };
