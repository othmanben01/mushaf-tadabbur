// Counts one app opening: total and per-day visits, and unique visitors (anonymous random id kept on the phone).
const { pipeline, day } = require("./_redis");
const YEAR = 60 * 60 * 24 * 400;
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).end();
  let b = req.body; if (typeof b === "string") { try { b = JSON.parse(b) } catch (e) { b = {} } }
  const id = String((b && b.id) || "").replace(/[^a-z0-9]/gi, "").slice(0, 32);
  if (id.length < 8) return res.status(400).end();
  const d = day();
  try {
    await pipeline([
      ["INCR", "visits:all"], ["INCR", "visits:" + d], ["EXPIRE", "visits:" + d, YEAR],
      ["PFADD", "uv:all", id], ["PFADD", "uv:" + d, id], ["EXPIRE", "uv:" + d, YEAR],
      ["SADD", "seen", id]
    ]).then(async r => { if (r[6] === 1) await pipeline([["INCR", "new:" + d], ["EXPIRE", "new:" + d, YEAR]]) });
    res.status(204).end();
  } catch (e) { res.status(503).json({ error: e.message }) }
};
