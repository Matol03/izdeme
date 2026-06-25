const L = require("../_lib");
module.exports = (req, res) => {
  res.status(200).json({ enabled: !!L.OPENAI_KEY, model: L.OPENAI_MODEL });
};
