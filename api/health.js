const L = require("./_lib");
module.exports = (req, res) => {
  res.status(200).json({ ok: true, userAgent: L.HH_USER_AGENT, area: L.HH_AREA, host: L.HH_HOST, oauth: !!L.HH_CLIENT_ID, platform: "vercel" });
};
