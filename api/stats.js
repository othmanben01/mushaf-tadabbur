// Visitor numbers for the hidden #admin page. Protected by the ADMIN_KEY environment variable.
const { pipeline, day } = require("./_redis");
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const key = (req.query && req.query.key) || "";
  if (!process.env.ADMIN_KEY) return res.status(503).json({ error: "no_key" });
  if (key !== process.env.ADMIN_KEY) return res.status(401).json({ error: "bad_key" });
  const days = []; const now = Date.now();
  for (let i = 29; i >= 0; i--) days.push(day(new Date(now - i * 864e5)));
  const cmds = [["GET", "visits:all"], ["PFCOUNT", "uv:all"]];
  for (const d of days) cmds.push(["PFCOUNT", "uv:" + d], ["GET", "visits:" + d], ["GET", "new:" + d]);
  const w7 = days.slice(-7).map(d => "uv:" + d), w30 = days.map(d => "uv:" + d);
  cmds.push(["PFCOUNT", ...w7], ["PFCOUNT", ...w30]);
  try {
    const r = await pipeline(cmds);
    const per = days.map((d, i) => ({ d, users: +r[2 + i * 3] || 0, visits: +r[3 + i * 3] || 0, new: +r[4 + i * 3] || 0 }));
    res.status(200).json({ visits: +r[0] || 0, users: +r[1] || 0, week: +r[r.length - 2] || 0, month: +r[r.length - 1] || 0, days: per });
  } catch (e) { res.status(503).json({ error: e.message }) }
};
