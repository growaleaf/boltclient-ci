#!/usr/bin/env node
'use strict';

// Boltclient CI runner — self-contained, dependency-free (Node 18+, no npm install).
// This file is yours forever: it does not require the VS Code extension to keep working.
// Runs a Boltclient collection (or a Thunder Client / Postman v2.1 export, auto-detected)
// against a named environment and exits non-zero if any request comes back 4xx/5xx or fails
// to connect — a smoke test for an API, run from CI before you deploy it.
//
// Requires a Pro license, checked OFFLINE (no network call, no account, no phone-home) from
// ~/.boltclient/license or the BOLTCLIENT_KEY env var — put the latter in your CI secrets.
//
// Usage:
//   node cli.js run [--file <collection.json>] [--dir <.boltclient dir>] [--env <name>] [--json]
//
// Exit codes:
//   0 - every request returned 2xx/3xx
//   1 - one or more requests returned 4xx/5xx, or failed to connect
//   2 - configuration/usage error (no collection found, bad JSON, --dir missing)
//   3 - license key missing or invalid
//
// Request execution and {{var}} substitution are a hand-maintained mirror of the VS Code
// extension's own extension.js executeRequest()/substitute() (minus VS Code SecretStorage,
// which this CLI reads from process.env instead) and src/importers.js's importAny() — kept in
// parity by this package's own test suite running these SAME functions against real fixtures
// and a real local HTTP server, not a reimplementation guessed from memory.

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

// ---------------------------------------------------------------------------------------
// License (BP-001 offline ECDSA-P256 verify) — identical public key and BC1 prefix to the
// VS Code extension's src/license.js, including the canonical-base64url round-trip check
// (the tamper-bypass coin-flip bug found and fixed across all 6 D-lane extensions on
// 2026-09-07, then re-introduced once in the first standalone CLI, localbolt-ci, before
// being caught and fixed 2026-10-13). Shipped here already in place, not bolted on after.
// ---------------------------------------------------------------------------------------
const PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEcOIAYPZI5nlKg8PziGmGQ4nCAm3ImuvBNQULKBydjgMFAtCDnEq9dAJL4pDUzGHgUGOc0VEr6xJktG4Q/jVtag==\n-----END PUBLIC KEY-----';
const LICENSE_PRODUCT = 'boltclient-pro';

function b64urlToBuf(s) {
  const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const canonical = buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (canonical !== s) throw new Error('non-canonical base64url');
  return buf;
}

function verifyLicenseWith(key, pubPem) {
  try {
    if (typeof key !== 'string') return false;
    const parts = key.trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'BC1') return false;
    const signedData = `BC1.${parts[1]}`;
    const payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
    if (payload.product !== LICENSE_PRODUCT) return false;
    if (payload.exp && Date.now() > payload.exp) return false;
    const v = crypto.createVerify('SHA256');
    v.update(signedData); v.end();
    return v.verify(pubPem, b64urlToBuf(parts[2]));
  } catch (e) { return false; }
}

function verifyLicense(key) {
  if (PUBLIC_KEY_PEM.includes('PLACEHOLDER')) return false;
  return verifyLicenseWith(key, PUBLIC_KEY_PEM);
}

function readLicenseKey() {
  if (process.env.BOLTCLIENT_KEY) return process.env.BOLTCLIENT_KEY.trim();
  try {
    return fs.readFileSync(path.join(os.homedir(), '.boltclient', 'license'), 'utf8').trim();
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// Importers — identical to src/importers.js (pure JSON transform, no VS Code dependency).
// ---------------------------------------------------------------------------------------
function kv(arr, kName, vName) {
  return (arr || []).filter(Boolean).map((o) => ({ key: o[kName] ?? o.key ?? '', value: o[vName] ?? o.value ?? '', enabled: o.isDisabled ? false : true }));
}

function importThunderClient(raw) {
  if (!raw || (raw.clientName !== 'Thunder Client' && !Array.isArray(raw.requests))) return null;
  const skipped = [];
  const requests = [];
  for (const r of (raw.requests || [])) {
    if (!r.url) { skipped.push(r.name || '(unnamed)'); continue; }
    let body = '', bodyType = 'none';
    if (r.body && r.body.raw) { body = r.body.raw; bodyType = (r.body.type === 'json' || /json/i.test(r.body.type || '')) ? 'json' : 'raw'; }
    requests.push({
      name: r.name || r.url,
      method: (r.method || 'GET').toUpperCase(),
      url: r.url,
      params: kv(r.params, 'name', 'value'),
      headers: kv(r.headers, 'name', 'value'),
      body, bodyType,
    });
  }
  return { name: raw.collectionName || 'thunder-import', collection: { name: raw.collectionName || 'thunder-import', requests }, skipped };
}

function importPostman(raw) {
  const isV21 = (raw && raw.info && /2\.1\.0/.test(raw.info.schema || '')) || (raw && Array.isArray(raw.item));
  if (!isV21) return null;
  const skipped = [];
  const requests = [];
  const walk = (items) => {
    for (const it of (items || [])) {
      if (Array.isArray(it.item)) { walk(it.item); continue; } // folder
      const req = it.request;
      if (!req) { skipped.push(it.name || '(unnamed)'); continue; }
      const urlRaw = typeof req.url === 'string' ? req.url : (req.url && req.url.raw) || '';
      if (!urlRaw) { skipped.push(it.name || '(unnamed)'); continue; }
      let body = '', bodyType = 'none';
      if (req.body && req.body.mode === 'raw' && req.body.raw) {
        body = req.body.raw;
        const lang = req.body.options && req.body.options.raw && req.body.options.raw.language;
        bodyType = lang === 'json' ? 'json' : 'raw';
      }
      requests.push({
        name: it.name || urlRaw,
        method: (req.method || 'GET').toUpperCase(),
        url: urlRaw,
        params: kv(req.url && req.url.query, 'key', 'value'),
        headers: kv(req.header, 'key', 'value'),
        body, bodyType,
      });
    }
  };
  walk(raw.item);
  const name = (raw.info && raw.info.name) || 'postman-import';
  return { name, collection: { name, requests }, skipped };
}

function importAny(raw) {
  return importThunderClient(raw) || importPostman(raw);
}

function asCollection(raw) {
  // Already a Boltclient-native collection: { name, requests: [...] }.
  if (raw && Array.isArray(raw.requests) && raw.clientName !== 'Thunder Client') {
    const looksNative = raw.requests.every((r) => typeof r === 'object' && 'url' in r && !('isDisabled' in (r.params?.[0] || {})));
    if (looksNative || raw.requests.length === 0) return { name: raw.name || 'collection', requests: raw.requests, skipped: [] };
  }
  const imported = importAny(raw);
  if (imported) return { name: imported.collection.name, requests: imported.collection.requests, skipped: imported.skipped };
  return null;
}

// ---------------------------------------------------------------------------------------
// Environments — identical shape to the extension's environments.json. Secret-flagged
// variables ({secret:true}) have no VS Code SecretStorage here, so the CLI reads them from
// process.env[KEY] (exact case) or process.env[KEY.toUpperCase()] — documented in README.
// ---------------------------------------------------------------------------------------
function substitute(str, vars) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, name) => (name in vars ? vars[name] : m));
}

function loadEnvVars(dir, envName) {
  if (!envName) return {};
  const envFile = path.join(dir, 'environments.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(envFile, 'utf8')); } catch (e) { return {}; }
  const vars = (data.environments && data.environments[envName]) || {};
  const map = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v && typeof v === 'object' && v.secret) {
      map[k] = process.env[k] != null ? process.env[k] : (process.env[k.toUpperCase()] != null ? process.env[k.toUpperCase()] : '');
    } else {
      map[k] = String(v);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------------------
// Request execution — identical to extension.js's executeRequest(), minus vscode.
// ---------------------------------------------------------------------------------------
function executeRequest(req) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(req.url); } catch (e) {
      return resolve({ ok: false, error: `Invalid URL: ${req.url}` });
    }
    for (const p of (req.params || [])) {
      if (p && p.enabled !== false && p.key) u.searchParams.append(p.key, p.value == null ? '' : p.value);
    }
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const headers = {};
    for (const h of (req.headers || [])) {
      if (h && h.enabled !== false && h.key) headers[h.key] = h.value == null ? '' : h.value;
    }
    let bodyBuf = null;
    if (req.body != null && req.body !== '' && !['GET', 'HEAD'].includes((req.method || 'GET').toUpperCase())) {
      if (req.bodyType === 'json' && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
      bodyBuf = Buffer.from(req.body, 'utf8');
      headers['Content-Length'] = String(bodyBuf.length);
    }
    const started = Date.now();
    const options = {
      method: (req.method || 'GET').toUpperCase(),
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers,
      timeout: 30000,
    };
    const clientReq = lib.request(options, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size <= 10 * 1024 * 1024) chunks.push(c); });
      res.on('end', () => {
        resolve({
          ok: true,
          status: res.statusCode,
          timeMs: Date.now() - started,
          sizeBytes: size,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    clientReq.on('timeout', () => { clientReq.destroy(); resolve({ ok: false, error: 'Request timed out after 30s.' }); });
    clientReq.on('error', (err) => resolve({ ok: false, error: `${err.message} (${err.code || 'unknown'})` }));
    if (bodyBuf) clientReq.write(bodyBuf);
    clientReq.end();
  });
}

// ---------------------------------------------------------------------------------------
// Run a collection against resolved environment vars. A request "fails" the smoke test if
// it could not connect, or if it returned 4xx/5xx — 2xx/3xx is treated as healthy.
// ---------------------------------------------------------------------------------------
async function runCollection(collection, envVars) {
  const results = [];
  for (const r of (collection.requests || [])) {
    const req = {
      method: r.method,
      url: substitute(r.url, envVars),
      params: (r.params || []).map((p) => ({ ...p, key: substitute(p.key, envVars), value: substitute(p.value, envVars) })),
      headers: (r.headers || []).map((h) => ({ ...h, key: substitute(h.key, envVars), value: substitute(h.value, envVars) })),
      body: substitute(r.body, envVars),
      bodyType: r.bodyType,
    };
    const resp = await executeRequest(req);
    const failed = !resp.ok || resp.status >= 400;
    results.push({ name: r.name || req.url, method: req.method, url: req.url, status: resp.ok ? resp.status : null, timeMs: resp.timeMs, error: resp.ok ? null : resp.error, failed });
  }
  return { breach: results.some((r) => r.failed), results };
}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------
class ConfigError extends Error {}

function readCollectionFile(filePath) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) {
    throw new ConfigError(`could not parse ${filePath} as JSON: ${e.message}`);
  }
  const collection = asCollection(raw);
  if (!collection) throw new ConfigError(`${filePath} is not a recognized Boltclient collection, Thunder Client export, or Postman v2.1 export`);
  return collection;
}

function resolveTarget(args) {
  if (args.file) {
    const p = path.resolve(process.cwd(), args.file);
    if (!fs.existsSync(p)) throw new ConfigError(`${p} does not exist`);
    return { collectionPath: p, dir: path.dirname(p) };
  }
  const dir = path.resolve(process.cwd(), args.dir || '.boltclient');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new ConfigError(`${dir} is not a directory (pass --file for a single collection, or --dir for a .boltclient folder)`);
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'environments.json');
  if (!files.length) throw new ConfigError(`${dir} has no collection .json files`);
  return { collectionPath: path.join(dir, files[0]), dir, multiple: files.length > 1 ? files : null };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--dir') args.dir = argv[++i];
    else if (a === '--env') args.env = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

function printHumanReport(collectionName, report) {
  console.log(`Boltclient CI — "${collectionName}", ${report.results.length} request(s):`);
  for (const r of report.results) {
    const flag = r.failed ? 'FAIL ' : 'ok   ';
    const detail = r.status != null ? `${r.status} in ${r.timeMs}ms` : r.error;
    console.log(`  ${flag} ${r.method.padEnd(6)} ${r.name} — ${detail}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0];

  if (args.help || !command) {
    console.log('Usage: node cli.js run [--file <collection.json>] [--dir <.boltclient dir>] [--env <name>] [--json]');
    process.exit(command ? 0 : 2);
    return;
  }
  if (command !== 'run') {
    console.error(`Unknown command "${command}". Only "run" is supported.`);
    process.exit(2);
    return;
  }

  const key = readLicenseKey();
  if (!key || !verifyLicense(key)) {
    console.error('Boltclient: no valid Pro license found. Set BOLTCLIENT_KEY (CI secret) or run "Boltclient: Enter Pro License Key" in VS Code to write ~/.boltclient/license.');
    process.exit(3);
    return;
  }

  let target;
  try {
    target = resolveTarget(args);
  } catch (e) {
    if (e instanceof ConfigError) { console.error(`Boltclient config error: ${e.message}`); process.exit(2); return; }
    throw e;
  }

  let collection;
  try {
    collection = readCollectionFile(target.collectionPath);
  } catch (e) {
    if (e instanceof ConfigError) { console.error(`Boltclient config error: ${e.message}`); process.exit(2); return; }
    throw e;
  }

  const envVars = loadEnvVars(target.dir, args.env);
  const report = await runCollection(collection, envVars);

  if (args.json) console.log(JSON.stringify({ collection: collection.name, ...report }, null, 2));
  else printHumanReport(collection.name, report);

  process.exit(report.breach ? 1 : 0);
}

if (require.main === module) main();

module.exports = {
  verifyLicense, verifyLicenseWith, importThunderClient, importPostman, importAny, asCollection,
  substitute, executeRequest, runCollection, readCollectionFile, loadEnvVars, resolveTarget,
};
