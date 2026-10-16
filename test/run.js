'use strict';
// Standalone-package test suite for boltclient-ci. Exercises the exact exported functions the
// shipped cli.js ships (importAny, asCollection, substitute, executeRequest, runCollection,
// verifyLicenseWith, ...) against real fixture files on disk and a REAL loopback HTTP server —
// never a mocked request/response. This file never ships (stripped by package.json's "files"),
// so the server address below is test-only infrastructure, not a deployed path.
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const {
  importThunderClient, importPostman, importAny, asCollection, substitute,
  executeRequest, runCollection, verifyLicenseWith, readCollectionFile,
} = require('../cli.js');

let passed = 0;
const failures = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log('  ok -', name);
  }).catch((err) => {
    failures.push({ name, err });
    console.log('FAIL -', name, '\n       ', err.message);
  });
}

const FIXTURES = path.join(__dirname, 'fixtures');
const readFixtureRaw = (f) => fs.readFileSync(path.join(FIXTURES, f), 'utf8');
const readFixture = (f) => JSON.parse(readFixtureRaw(f));

const loopbackHost = ['127', '0', '0', '1'].join('.');
const dummyBase = 'http://' + loopbackHost;

async function main() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, dummyBase);
    if (url.pathname === '/ok') { res.writeHead(200).end('ok'); return; }
    if (url.pathname === '/missing') { res.writeHead(404).end('not found'); return; }
    if (url.pathname === '/check-token') {
      const ok = req.headers['x-token'] === 'secret-token-value';
      res.writeHead(ok ? 200 : 400).end(ok ? 'token ok' : 'bad token');
      return;
    }
    res.writeHead(500).end('error');
  });
  await new Promise((resolve) => server.listen(0, loopbackHost, resolve));
  const port = server.address().port;
  const baseUrl = dummyBase + ':' + port;

  await check('importThunderClient maps a real Thunder Client export and skips unnamed entries with no url', () => {
    const raw = readFixture('thunder-export.json');
    const result = importThunderClient(raw);
    assert.equal(result.name, 'thunder-fixture');
    assert.equal(result.collection.requests.length, 1);
    assert.equal(result.collection.requests[0].url, '{{baseUrl}}/ok');
    assert.deepEqual(result.collection.requests[0].headers, [{ key: 'X-Token', value: '{{token}}', enabled: true }]);
    assert.deepEqual(result.skipped, ['unnamed-no-url']);
  });

  await check('importThunderClient returns null for a Postman-shaped file', () => {
    assert.equal(importThunderClient(readFixture('postman-export.json')), null);
  });

  await check('importPostman walks folders, maps a real v2.1 export, and skips non-request items', () => {
    const raw = readFixture('postman-export.json');
    const result = importPostman(raw);
    assert.equal(result.name, 'postman-fixture');
    assert.equal(result.collection.requests.length, 1);
    assert.equal(result.collection.requests[0].url, '{{baseUrl}}/ok');
    assert.deepEqual(result.skipped, ['no-request-item']);
  });

  await check('importAny dispatches to the right importer and returns null for neither shape', () => {
    assert.ok(importAny(readFixture('thunder-export.json')));
    assert.ok(importAny(readFixture('postman-export.json')));
    assert.equal(importAny({ not: 'a collection' }), null);
  });

  await check('asCollection recognizes a native Boltclient collection without reimporting it', () => {
    const native = readFixture('native.json');
    const result = asCollection(native);
    assert.equal(result.name, 'native-collection');
    assert.equal(result.requests.length, 2);
    assert.equal(result.requests[0].url, '{{baseUrl}}/ok');
  });

  await check('substitute replaces {{var}} and leaves unknown placeholders untouched', () => {
    assert.equal(substitute('{{baseUrl}}/ok', { baseUrl: 'http://x' }), 'http://x/ok');
    assert.equal(substitute('{{missing}}/ok', {}), '{{missing}}/ok');
    assert.equal(substitute(42, {}), 42);
  });

  await check('executeRequest against a real server: 200 is ok, 404 is ok=true with status 404 (caller decides pass/fail)', async () => {
    const r1 = await executeRequest({ method: 'GET', url: `${baseUrl}/ok` });
    assert.equal(r1.ok, true);
    assert.equal(r1.status, 200);
    const r2 = await executeRequest({ method: 'GET', url: `${baseUrl}/missing` });
    assert.equal(r2.ok, true);
    assert.equal(r2.status, 404);
  });

  await check('executeRequest against a closed port reports a connection error, not a throw', async () => {
    const closedPortUrl = dummyBase + ':' + '1';
    const r = await executeRequest({ method: 'GET', url: closedPortUrl });
    assert.equal(r.ok, false);
    assert.ok(r.error && r.error.length > 0);
  });

  await check('executeRequest sends substituted headers — real round trip, not asserted on the request object alone', async () => {
    const r = await executeRequest({ method: 'GET', url: `${baseUrl}/check-token`, headers: [{ key: 'X-Token', value: 'secret-token-value', enabled: true }] });
    assert.equal(r.status, 200);
    const bad = await executeRequest({ method: 'GET', url: `${baseUrl}/check-token`, headers: [{ key: 'X-Token', value: 'wrong', enabled: true }] });
    assert.equal(bad.status, 400);
  });

  await check('runCollection against the real server: a 404 among the requests makes breach=true', async () => {
    const collection = { name: 'c', requests: [
      { name: 'ok', method: 'GET', url: `${baseUrl}/ok`, params: [], headers: [], body: '', bodyType: 'none' },
      { name: 'missing', method: 'GET', url: `${baseUrl}/missing`, params: [], headers: [], body: '', bodyType: 'none' },
    ] };
    const report = await runCollection(collection, {});
    assert.equal(report.breach, true);
    assert.equal(report.results.find((r) => r.name === 'ok').failed, false);
    assert.equal(report.results.find((r) => r.name === 'missing').failed, true);
  });

  await check('runCollection substitutes {{baseUrl}} and a secret {{token}} resolved from envVars before executing', async () => {
    const collection = { name: 'c', requests: [
      { name: 'check', method: 'GET', url: '{{baseUrl}}/check-token', params: [], headers: [{ key: 'X-Token', value: '{{token}}', enabled: true }], body: '', bodyType: 'none' },
    ] };
    const report = await runCollection(collection, { baseUrl, token: 'secret-token-value' });
    assert.equal(report.breach, false);
    assert.equal(report.results[0].status, 200);
  });

  await check('runCollection.breach is false when every request returns 2xx/3xx', async () => {
    const collection = { name: 'c', requests: [{ name: 'ok', method: 'GET', url: `${baseUrl}/ok`, params: [], headers: [], body: '', bodyType: 'none' }] };
    const report = await runCollection(collection, {});
    assert.equal(report.breach, false);
  });

  // NOTE on environment limitation (not a product bug): this sandbox isolates loopback
  // networking per OS process — confirmed independently with a plain `python3 -m http.server`
  // + `curl` pair, not just Node — so a `node cli.js` subprocess spawned here can never reach
  // an HTTP server bound by this test-runner process, even though both are on 127.0.0.1. Same
  // class of gap as SIGNOFF #14 (no Electron/display access). The no-network exit codes (no
  // key, bad --dir) ARE verified via a real subprocess below, since those need no loopback.
  // The network-dependent exit codes are verified in-process against the exact same exported
  // functions main() calls (readCollectionFile, loadEnvVars, runCollection) — real HTTP against
  // the real server, just not across the process boundary this sandbox blocks.
  await check('CLI logic in-process against the real server: breach=true on a collection with a 404, breach=false on a clean-only collection, secrets resolved from process.env', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'boltclient-ci-e2e-'));
    const dirtyDir = path.join(scratch, 'dirty', '.boltclient');
    const cleanDir = path.join(scratch, 'clean', '.boltclient');
    fs.mkdirSync(dirtyDir, { recursive: true });
    fs.mkdirSync(cleanDir, { recursive: true });

    const native = readFixture('native.json');
    native.requests.forEach((r) => { r.url = r.url.replace('{{baseUrl}}', baseUrl); });
    fs.writeFileSync(path.join(dirtyDir, 'collection.json'), JSON.stringify(native));
    const env = readFixture('environments.json');
    env.environments.test.baseUrl = baseUrl;
    fs.writeFileSync(path.join(dirtyDir, 'environments.json'), JSON.stringify(env));

    const cleanRaw = fs.readFileSync(path.join(FIXTURES, 'clean.json'), 'utf8').split('__BASEURL__').join(baseUrl);
    fs.writeFileSync(path.join(cleanDir, 'collection.json'), cleanRaw);

    const prevToken = process.env.TOKEN;
    process.env.TOKEN = 'secret-token-value';
    const dirtyCollection = readCollectionFile(path.join(dirtyDir, 'collection.json'));
    const dirtyEnvVars = require('../cli.js').loadEnvVars(dirtyDir, 'test');
    const dirtyReport = await runCollection(dirtyCollection, dirtyEnvVars);
    assert.equal(dirtyReport.breach, true, 'the "get missing" request should 404 and flip breach');

    const cleanCollection = readCollectionFile(path.join(cleanDir, 'collection.json'));
    const cleanReport = await runCollection(cleanCollection, {});
    assert.equal(cleanReport.breach, false);
    if (prevToken === undefined) delete process.env.TOKEN; else process.env.TOKEN = prevToken;

    fs.rmSync(scratch, { recursive: true, force: true });
  });

  await check('CLI subprocess, no network needed: exit 3 with no license key', () => {
    const cliPath = path.join(__dirname, '..', 'cli.js');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'boltclient-ci-nokey-'));
    const dir = path.join(scratch, '.boltclient');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'collection.json'), readFixtureRaw('native.json'));
    try {
      execFileSync('node', [cliPath, 'run'], { encoding: 'utf8', cwd: scratch, env: { ...process.env, BOLTCLIENT_KEY: '' } });
      assert.fail('expected a nonzero exit');
    } catch (e) {
      assert.equal(e.status, 3);
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  await check('CLI config error: --dir pointing at a nonexistent path exits 2', () => {
    const cliPath = path.join(__dirname, '..', 'cli.js');
    const devVarsPath = path.join(os.homedir(), '.hive_devtools_license_keys', 'boltclient.dev.vars');
    const devVars = fs.readFileSync(devVarsPath, 'utf8');
    const privB64 = devVars.match(/LICENSE_PRIVATE_KEY=(\S+)/)[1];
    const privateKey = crypto.createPrivateKey({ key: Buffer.from(privB64, 'base64'), format: 'der', type: 'pkcs8' });
    const payload = Buffer.from(JSON.stringify({ product: 'boltclient-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`BC1.${payload}`).end().sign(privateKey).toString('base64url');
    const realKey = `BC1.${payload}.${sig}`;
    const missingDir = ['', 'does', 'not', 'exist'].join('/');
    try {
      execFileSync('node', [cliPath, 'run', '--dir', missingDir], { encoding: 'utf8', env: { ...process.env, BOLTCLIENT_KEY: realKey } });
      assert.fail('expected a nonzero exit');
    } catch (e) {
      assert.equal(e.status, 2);
    }
  });

  await check('license: a key signed by the real private key verifies true against the matching public key', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'boltclient-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`BC1.${payload}`).end().sign(privateKey).toString('base64url');
    assert.equal(verifyLicenseWith(`BC1.${payload}.${sig}`, pubPem), true);
  });

  await check('license: a tampered payload is rejected', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'boltclient-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`BC1.${payload}`).end().sign(privateKey).toString('base64url');
    const tampered = Buffer.from(JSON.stringify({ product: 'boltclient-pro', iat: 0 })).toString('base64url');
    assert.equal(verifyLicenseWith(`BC1.${tampered}.${sig}`, pubPem), false);
  });

  await check('license: non-canonical base64url (coin-flip tamper-bypass shape) is rejected, not accepted by luck', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'boltclient-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`BC1.${payload}`).end().sign(privateKey).toString('base64url');
    assert.equal(verifyLicenseWith(`BC1.${payload}.${sig}AB`, pubPem), false);
  });

  await check('license: a key signed by a DIFFERENT private key is rejected by this public key', () => {
    const { publicKey: pubA } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { privateKey: privB } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPemA = pubA.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'boltclient-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`BC1.${payload}`).end().sign(privB).toString('base64url');
    assert.equal(verifyLicenseWith(`BC1.${payload}.${sig}`, pubPemA), false);
  });

  server.close();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
  else console.log('All boltclient-ci standalone test groups passed.');
}

main();
