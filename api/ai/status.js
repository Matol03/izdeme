const L = require("../_lib");
module.exports = (req, res) => {
  const s = L.providerStatus();
  res.status(200).json({ enabled: s.providers.some(p => p.enabled), ...s });
};
