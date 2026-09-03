import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const { Client } = pg;
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

async function expectConstraint(
  savepoint: string,
  expectedCode: string,
  operation: () => Promise<unknown>,
) {
  await client.query(`savepoint ${savepoint}`);
  try {
    await operation();
    assert.fail(`expected PostgreSQL error ${expectedCode}`);
  } catch (error) {
    assert.equal(
      error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined,
      expectedCode,
    );
  } finally {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
  }
}

try {
  await client.query("begin");
  const installed = await client.query(
    "select to_regprocedure('public.lookup_acceptable_invitation(text,text)') is not null as installed",
  );
  if (!installed.rows[0]?.installed) {
    await client.query(await readFile(
      new URL("../migrations/0033_g1_identity_integrity.sql", import.meta.url),
      "utf8",
    ));
  }

  const planId = randomUUID();
  const organizationA = randomUUID();
  const organizationB = randomUUID();
  const userId = randomUUID();
  const groupA = randomUUID();
  const groupB = randomUUID();
  const invitationId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiredHash = createHash("sha256").update("expired").digest("hex");
  const undeliveredHash = createHash("sha256").update("undelivered").digest("hex");
  const acceptedHash = createHash("sha256").update("accepted").digest("hex");

  await client.query(
    "insert into plans(id,code,name,storage_limit_gb,entitlements) values($1,$2,$3,10,'{}')",
    [planId, `g1-${planId}`, "G1 smoke",],
  );
  await client.query(
    "insert into organizations(id,name,slug,status,plan_id) values($1,'Org A',$2,'active',$3),($4,'Org B',$5,'active',$3)",
    [organizationA, `org-a-${organizationA}`, planId, organizationB, `org-b-${organizationB}`],
  );
  await client.query(
    "insert into users(id,email,name) values($1,'g1-smoke@example.test','G1 smoke')",
    [userId],
  );
  await client.query(
    "insert into permission_groups(id,organization_id,name,system_key) values($1,$2,'Owners','owners'),($3,$4,'Owners','owners')",
    [groupA, organizationA, groupB, organizationB],
  );

  await expectConstraint("cross_org_membership", "23503", () => client.query(
    "insert into memberships(organization_id,user_id,group_id) values($1,$2,$3)",
    [organizationA, userId, groupB],
  ));
  await expectConstraint("cross_org_invitation", "23503", () => client.query(
    "insert into invitations(organization_id,email,group_id,token_hash,invited_by_user_id,expires_at,delivered_at) values($1,'wrong-org@example.test',$2,$3,$4,now()+interval '1 day',now())",
    [organizationA, groupB, createHash("sha256").update("cross-org").digest("hex"), userId],
  ));

  await client.query(
    "insert into invitations(id,organization_id,email,group_id,token_hash,invited_by_user_id,expires_at,delivered_at) values($1,$2,'Invitee@Example.Test',$3,$4,$5,now()+interval '1 day',now())",
    [invitationId, organizationA, groupA, tokenHash, userId],
  );
  await client.query(
    `insert into invitations(organization_id,email,group_id,token_hash,invited_by_user_id,expires_at,delivered_at,accepted_at,accepted_by_user_id)
     values
       ($1,'expired@example.test',$2,$3,$4,now()-interval '1 second',now(),null,null),
       ($1,'undelivered@example.test',$2,$5,$4,now()+interval '1 day',null,null,null),
       ($1,'accepted@example.test',$2,$6,$4,now()+interval '1 day',now(),now(),$4)`,
    [organizationA, groupA, expiredHash, userId, undeliveredHash, acceptedHash],
  );
  await expectConstraint("duplicate_invitation", "23505", () => client.query(
    "insert into invitations(organization_id,email,group_id,token_hash,invited_by_user_id,expires_at,delivered_at) values($1,'invitee@example.test',$2,$3,$4,now()+interval '1 day',now())",
    [organizationA, groupA, createHash("sha256").update("duplicate").digest("hex"), userId],
  ));

  await client.query("set local role vid_app");
  assert.equal(
    (await client.query("select id from invitations where id=$1", [invitationId])).rowCount,
    0,
    "RLS must hide invitations before tenant context is set",
  );
  const capability = await client.query(
    "select * from public.lookup_acceptable_invitation($1,$2)",
    [tokenHash, "invitee@example.test"],
  );
  assert.deepEqual(capability.rows, [{
    invitation_id: invitationId,
    organization_id: organizationA,
  }]);
  assert.equal(
    (await client.query(
      "select * from public.lookup_acceptable_invitation($1,$2)",
      [tokenHash, "wrong@example.test"],
    )).rowCount,
    0,
    "the lookup capability must bind the token to the invited email",
  );
  for (const [hash, email, state] of [
    [expiredHash, "expired@example.test", "expired"],
    [undeliveredHash, "undelivered@example.test", "undelivered"],
    [acceptedHash, "accepted@example.test", "already accepted"],
  ]) {
    assert.equal(
      (await client.query(
        "select * from public.lookup_acceptable_invitation($1,$2)",
        [hash, email],
      )).rowCount,
      0,
      `${state} invitations must not produce a signup/acceptance capability`,
    );
  }

  await client.query("select set_config('app.organization_id',$1,true)", [organizationB]);
  assert.equal(
    (await client.query("select id from invitations where id=$1", [invitationId])).rowCount,
    0,
    "RLS must reject a foreign tenant context",
  );
  await client.query("select set_config('app.organization_id',$1,true)", [organizationA]);
  assert.equal(
    (await client.query("select id from invitations where id=$1", [invitationId])).rowCount,
    1,
    "RLS must permit the owning tenant context",
  );

  await client.query("reset role");
  await client.query(
    "update invitations set revoked_at=now() where id=$1",
    [invitationId],
  );
  await client.query("set local role vid_app");
  assert.equal(
    (await client.query(
      "select * from public.lookup_acceptable_invitation($1,$2)",
      [tokenHash, "invitee@example.test"],
    )).rowCount,
    0,
    "revoked invitations must not produce a signup/acceptance capability",
  );

  console.log("G1 rollback-only database smoke passed");
} finally {
  await client.query("rollback").catch(() => undefined);
  await client.end();
}