const L = require("../_lib");
module.exports = async (req, res) => {
  try {
    const { resume, vacancy } = L.body(req);
    if (!resume || !vacancy) return res.status(400).json({ error: "resume and vacancy required" });
    const out = await L.aiTailor(resume, vacancy);
    res.status(200).json({ source: L.LLM_PROVIDER, model: L.LLM_MODEL, ...out });
  } catch (e) {
    res.status(e.code === "NO_KEY" ? 503 : 502).json({ error: e.message, disabled: e.code === "NO_KEY" });
  }
};
