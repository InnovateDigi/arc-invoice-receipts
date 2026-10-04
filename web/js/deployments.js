// Written by scripts/write-web-config.js from deployments/*.json (the deploy script runs it). An empty contract means
// "not deployed on this network yet". Safe to edit by hand.
if (typeof window === 'undefined') { var window = {}; }
window.ArcInvoiceDeployments = {
  "arcTestnet": {
    "contract": "",
    "deployBlock": 0
  },
  "arcMainnet": {
    "contract": "",
    "deployBlock": 0
  },
  "local": {
    "contract": "",
    "deployBlock": 0
  }
};
if (typeof module === 'object' && module.exports) module.exports = window.ArcInvoiceDeployments;
