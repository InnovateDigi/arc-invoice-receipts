"use strict";
// Loads the deployer private key WITHOUT ever printing it.
//   PRIVATE_KEY=0x...            a 32-byte hex key in the environment, or
//   DEPLOYER_KEY_FILE=/path      a file holding the bare hex key, or JSON with a "privateKey" field,
//                                or an encrypted keystore (then also set KEYSTORE_PASSWORD).
// Returns a 0x-prefixed 32-byte hex string, or null when nothing is configured.
const fs = require("fs");

const HEX32 = /^(0x)?[0-9a-fA-F]{64}$/;

function normalise(s) {
  return s.startsWith("0x") ? s : "0x" + s;
}

function findKeyInJson(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== "object") return null;
  for (const [name, v] of Object.entries(value)) {
    if (typeof v === "string" && /priv|secret|^key$/i.test(name) && HEX32.test(v.trim())) return normalise(v.trim());
  }
  for (const v of Object.values(value)) {
    const found = findKeyInJson(v, depth + 1);
    if (found) return found;
  }
  return null;
}

function loadKey() {
  const env = process.env.PRIVATE_KEY;
  if (env && HEX32.test(env.trim())) return normalise(env.trim());

  const file = process.env.DEPLOYER_KEY_FILE;
  if (!file) return null;
  const raw = fs.readFileSync(file, "utf8").trim();
  if (HEX32.test(raw)) return normalise(raw);

  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error("DEPLOYER_KEY_FILE is neither a hex key nor JSON");
  }
  const direct = findKeyInJson(json);
  if (direct) return direct;
  if (json && (json.crypto || json.Crypto) && process.env.KEYSTORE_PASSWORD) {
    const { Wallet } = require("ethers");
    return Wallet.fromEncryptedJsonSync(raw, process.env.KEYSTORE_PASSWORD).privateKey;
  }
  throw new Error("DEPLOYER_KEY_FILE has no recognisable private key field");
}

module.exports = { loadKey };
