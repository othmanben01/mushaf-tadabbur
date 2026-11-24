// Tiny Upstash Redis REST client (the database added from Vercel > Storage > Upstash Redis).
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
async function pipeline(cmds) {
  if (!URL_ || !TOKEN) throw new Error("no_db");
  const r = await fetch(URL_ + "/pipeline", { method: "POST", headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error("db_" + r.status);
  return (await r.json()).map(x => x.result);
}
const day = (d = new Date()) => d.toISOString().slice(0, 10);
module.exports = { pipeline, day };
