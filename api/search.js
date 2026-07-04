const L = require("./_lib");
module.exports = async (req, res) => {
  const q = ((req.query && req.query.text) || "").trim();
  if (!q) return res.status(400).json({ error: "missing 'text' query param" });
  try {
    const provider = (req.query && req.query.provider) || undefined;
    const result = await L.aiSearch(q, provider);
    res.status(200).json({ source: "hh.kz · AI", ...result });
  } catch (e) {
    // NO_KEY (LLM off) or hh error → frontend falls back to plain /api/vacancies
    res.status(e.code === "NO_KEY" ? 503 : 502).json({ error: e.message, disabled: e.code === "NO_KEY" });
  }
};
