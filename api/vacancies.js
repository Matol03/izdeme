const L = require("./_lib");
module.exports = async (req, res) => {
  const q = ((req.query && req.query.text) || "").trim();
  if (!q) return res.status(400).json({ error: "missing 'text' query param" });
  try {
    const perPage = Number((req.query && req.query.per_page) || 30);
    const result = await L.fetchVacancies(q, { perPage });
    res.status(200).json({ source: "hh.kz", ...result });
  } catch (e) {
    res.status(502).json({
      error: e.message,
      ddosGuard: !!e.ddosGuard,
      hint: e.ddosGuard
        ? "DDoS-Guard blocked this server IP. Use the client-side path, or register an app + OAuth token at https://dev.hh.ru/admin."
        : "hh.kz request failed — check User-Agent / rate limits.",
    });
  }
};
