const L = require("../_lib");
module.exports = async (req, res) => {
  try {
    const { resume, vacancy, provider } = L.body(req);
    if (!resume || !vacancy) return res.status(400).json({ error: "resume and vacancy required" });
    const out = await L.aiTailor(resume, vacancy, provider);
    const p = L.providerOf(provider);
    res.status(200).json({ source: p.label, provider: p.id, model: p.model, ...out });
  } catch (e) {
    res.status(e.code === "NO_KEY" ? 503 : 502).json({ error: e.message, disabled: e.code === "NO_KEY" });
  }
};
