/*
 * Arc Invoice Receipts - network configuration. Classic script (no modules), also require()-able in Node.
 * Nothing secret lives here. Set REPO_URL to show a "Source code" link in the footer of every page.
 */
(function (root, factory) {
  var config = factory();
  if (typeof module === 'object' && module.exports) module.exports = config;
  else root.ArcInvoiceConfig = config;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return {
    REPO_URL: '',
    // receiptTimeoutMs: how long a page waits for a transaction receipt before it says "not confirmed yet" (default 120000).
    // rpcs.read: order for ordinary reads and transactions (the first one is also `rpc`, used when adding the chain to a wallet).
    // rpcs.logs: order for eth_getLogs scans. The primary public RPCs rate-limit after a handful of back-to-back requests
    // and allow 9,999 blocks per eth_getLogs call; the provider endpoints listed first for logs allow up to 100,000 blocks
    // and do not rate-limit in practice. The client rotates to the next endpoint on HTTP 429 / -32005 / network errors.
    // The numbers are hints (logRange = blocks per eth_getLogs call, spacingMs = minimum gap between requests,
    // concurrency = parallel requests); the client corrects a wrong hint by itself.
    networks: {
      arcTestnet: {
        key: 'arcTestnet',
        name: 'Arc Testnet',
        chainId: 5042002,
        rpc: 'https://rpc.testnet.arc.io',
        rpcs: {
          read: [
            { url: 'https://rpc.testnet.arc.io', logRange: 9999, spacingMs: 250, concurrency: 1 },
            { url: 'https://rpc.blockdaemon.testnet.arc.io', logRange: 90000, concurrency: 4 },
            { url: 'https://rpc.quicknode.testnet.arc.io', logRange: 9999, spacingMs: 250, concurrency: 1 }
          ],
          logs: [
            { url: 'https://rpc.blockdaemon.testnet.arc.io', logRange: 90000, concurrency: 4 },
            { url: 'https://rpc.testnet.arc.io', logRange: 9999, spacingMs: 250, concurrency: 1 },
            { url: 'https://rpc.quicknode.testnet.arc.io', logRange: 9999, spacingMs: 250, concurrency: 1 }
          ]
        },
        explorer: 'https://explorer.testnet.arc.io',
        testnet: true
      },
      arcMainnet: {
        key: 'arcMainnet',
        name: 'Arc',
        chainId: 5042,
        rpc: 'https://rpc.mainnet.arc.io',
        rpcs: {
          read: [
            { url: 'https://rpc.mainnet.arc.io', logRange: 9999, spacingMs: 250, concurrency: 1 },
            { url: 'https://rpc.blockdaemon.mainnet.arc.io', logRange: 90000, concurrency: 4 },
            { url: 'https://rpc.quicknode.mainnet.arc.io', logRange: 9999, spacingMs: 250, concurrency: 1 }
          ],
          logs: [
            { url: 'https://rpc.blockdaemon.mainnet.arc.io', logRange: 90000, concurrency: 4 },
            { url: 'https://rpc.mainnet.arc.io', logRange: 9999, spacingMs: 250, concurrency: 1 },
            { url: 'https://rpc.quicknode.mainnet.arc.io', logRange: 9999, spacingMs: 250, concurrency: 1 }
          ]
        },
        explorer: 'https://explorer.arc.io',
        testnet: false
      },
      local: {
        key: 'local',
        name: 'Local dev',
        chainId: 31337,
        rpc: 'http://127.0.0.1:8545',
        explorer: '',
        dev: true
      }
    },
    defaultNetwork: 'arcTestnet'
  };
});
