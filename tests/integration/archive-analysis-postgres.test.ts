import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { buildApp } from "../../apps/api/src/app";
import { bootstrapOwner } from "../../src/modules/access/sql";
import { testDatabase } from "../helpers/database";

test("PG16 archive references enforce project and source grants without writing content, batches, jobs or usage", async t => {
  const db = await testDatabase();
  t.after(db.close);
  const origin = "http://archive-test.local";
  const password = "archive-fixture-password-123";
  await bootstrapOwner(db.pool, password, "owner@archive.test");
  const sourceId = randomUUID();
  const shared = randomUUID();
  const privateProject = randomUUID();
  const viewerProject = randomUUID();
  const token = "local-only-service-fixture-".repeat(2);
  const selection = {
    archiveId: "reddit-local-corpus", version: "f".repeat(64),
    scope: { query: "DuckDB", months: ["2026-10"], subreddits: ["LocalLLaMA"], from: null, to: null },
  };
  const empty = { query: "", subreddits: [], from: null, to: null };
  const calls: { path?: string; data: Record<string, unknown> }[] = [];
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer " + token);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      calls.push({ path: request.url, data: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {} });
      const body = JSON.stringify(request.url === "/archives"
        ? { archiveId: selection.archiveId, version: selection.version, months: [
          { month: "2026-10", from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z", postsRows: 0, commentsRows: 0 },
        ] }
        : { posts: [], nextCursor: null, totalMatches: 0, sampleSize: 0, isTruncated: false, months: selection.scope.months });
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      response.end(body);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const configs = {
    ARCHIVE_ANALYSIS_ENABLED: "true",
    ARCHIVE_ANALYSIS_SOURCE_ID: sourceId,
    ARCHIVE_ANALYSIS_BASE_URL: `http://127.0.0.1:${address.port}`,
    ARCHIVE_ANALYSIS_SERVICE_TOKEN: token,
  };
  for (const [key, value] of Object.entries(configs)) {
    const before = process.env[key];
    t.after(() => {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    });
    process.env[key] = value;
  }
  const app = await buildApp({
    pool: db.pool, origin, secureCookies: false, providers: [], publicRegistration: true,
    sessionSecret: "archive-pg-test-fixture".repeat(3),
  });
  t.after(() => app.close());

  async function authenticate(email: string, register = false) {
    const response = await app.inject({
      method: "POST", url: "/v1/auth/" + (register ? "register" : "login"), headers: { origin },
      payload: { email, password },
    });
    assert.ok(response.statusCode < 300, response.body);
    if (!response.headers["set-cookie"]) {
      assert.ok(register);
      const login = await app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin }, payload: { email, password } });
      assert.equal(login.statusCode, 200, login.body);
      return { origin, cookie: login.headers["set-cookie"]!.toString().split(";")[0] };
    }
    return { origin, cookie: response.headers["set-cookie"].toString().split(";")[0] };
  }
  const owner = await authenticate("owner@archive.test");
  const viewer = await authenticate("viewer@archive.test", true);
  const user = (await db.pool.query("SELECT id FROM app_user WHERE email='viewer@archive.test'")).rows[0].id as string;
  await db.pool.query(
    `INSERT INTO collection_source(id,platform_id,primary_provider,delivery_mode,label,target,content_kind,state,tags,created_at,updated_at)
     SELECT $1,id,'external_ingest','push','R4 fixture','{"type":"search","query":"archive"}','post','active',ARRAY['reddit-archive'],now(),now()
     FROM source WHERE code='reddit'`, [sourceId],
  );
  await db.pool.query(
    `INSERT INTO monitor_project(id,name,dataset_mode,visibility,owner_user_id)
     VALUES ($1,'Shared archive','batch','shared',NULL), ($2,'Private archive','batch','private',NULL),
            ($3,'Viewer archive','batch','private',$4)`, [shared, privateProject, viewerProject, user],
  );
  const snapshot = async () => (await db.pool.query(`SELECT
    (SELECT count(*) FROM content) AS content,
    (SELECT count(*) FROM content_discovery) AS discoveries,
    (SELECT count(*) FROM collection_batch_item) AS items,
    (SELECT count(*) FROM source_collection_job) AS jobs,
    (SELECT count(*) FROM source_provider_usage) AS usage`)).rows[0];
  const before = await snapshot();
  const sharedPath = `/v1/projects/${shared}/archives`;
  const viewerPath = `/v1/projects/${viewerProject}/archives`;
  const denied = await app.inject({ method: "GET", url: sharedPath + "/status", headers: viewer });
  assert.deepEqual(denied.json(), { state: "archive_forbidden", catalog: null, source: null });
  assert.equal(calls.length, 0);

  const preview = await app.inject({ method: "POST", url: sharedPath + "/preview", headers: owner, payload: selection });
  assert.equal(preview.statusCode, 200, preview.body);
  const added = await app.inject({ method: "POST", url: sharedPath, headers: owner, payload: selection });
  assert.equal(added.statusCode, 200, added.body);
  const refId = added.json().id as string;
  const duplicate = await app.inject({ method: "POST", url: sharedPath, headers: owner, payload: {
    ...selection, scope: { ...selection.scope, subreddits: ["localllama", "LOCALLLAMA"] },
  } });
  assert.equal(duplicate.json().id, refId);

  const read = (headers: typeof owner, route = sharedPath) =>
    app.inject({ method: "POST", url: `${route}/${refId}/search`, headers, payload: { filters: { ...empty, query: "agent" } } });
  const beforeDenied = calls.length;
  assert.equal((await read(viewer)).statusCode, 403);
  assert.equal(calls.length, beforeDenied);
  await db.pool.query("UPDATE app_user SET quota_override=$2 WHERE id=$1", [user, { allowedSourceIds: [sourceId], manualCollectEnabled: false }]);

  assert.equal((await read(viewer, `/v1/projects/${privateProject}/archives`)).statusCode, 404);
  assert.equal((await read(viewer, viewerPath)).statusCode, 404);
  assert.equal(calls.length, beforeDenied);
  const scoped = await read(viewer);
  assert.equal(scoped.statusCode, 200, scoped.body);
  assert.deepEqual(calls.at(-1)?.data, {
    ...selection,
    scope: { ...selection.scope, subreddits: ["localllama"] }, reference: refId, filters: { ...empty, query: "agent" },
  });
  assert.equal((await app.inject({ method: "DELETE", url: `${sharedPath}/${refId}`, headers: viewer })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: viewerPath, headers: viewer, payload: selection })).statusCode, 200);
  assert.equal((await app.inject({ method: "DELETE", url: `${sharedPath}/${refId}`, headers: owner })).statusCode, 200);
  assert.equal((await read(owner)).statusCode, 404);
  assert.equal((await app.inject({ url: viewerPath, headers: viewer })).json().references.length, 1);
  assert.deepEqual(await snapshot(), before);

  process.env.ARCHIVE_ANALYSIS_ENABLED = "false";
  const disabled = await buildApp({
    pool: db.pool, origin, secureCookies: false, providers: [], sessionSecret: "archive-pg-test-fixture".repeat(3),
  });
  t.after(() => disabled.close());
  const beforeDisabled = calls.length;
  const disabledStatus = await disabled.inject({ url: sharedPath + "/status", headers: owner });
  assert.deepEqual(disabledStatus.json(), { state: "archive_disabled", catalog: null, source: null });
  assert.equal((await disabled.inject({ url: "/v1/projects", headers: owner })).statusCode, 200);
  assert.equal(calls.length, beforeDisabled);
});
