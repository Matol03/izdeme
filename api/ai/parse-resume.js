const L = require("../_lib");
module.exports = async (req, res) => {
  try {
    const { text } = L.body(req);
    if (!text || String(text).length < 20) return res.status(400).json({ error: "missing resume text" });
    const resume = await L.aiParseResume(text);
    res.status(200).json({ source: "openai", model: L.OPENAI_MODEL, resume });
  } catch (e) {
    res.status(e.code === "NO_KEY" ? 503 : 502).json({ error: e.message, disabled: e.code === "NO_KEY" });
  }
};
