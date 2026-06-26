const L = require("../_lib");
module.exports = (req, res) => {
  res.status(200).json({ enabled: !!L.LLM_API_KEY, model: L.LLM_MODEL, provider: L.LLM_PROVIDER });
};
