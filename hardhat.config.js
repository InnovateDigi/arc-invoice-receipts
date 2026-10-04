require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-network-helpers");
require("solidity-coverage");
require("@nomicfoundation/hardhat-verify");
const { loadKey } = require("./scripts/lib/key");

// The deployer key is read here only when PRIVATE_KEY or DEPLOYER_KEY_FILE is set. It is never printed.
const key = loadKey();
const accounts = key ? [key] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    // Local Arc-faithful node: `arc-anvil --network arc --port 8646` (Arc Foundry). Used to re-run the test suite
    // against Arc's own EVM rules: `npm run test:arc-anvil`.
    arcAnvil: { url: process.env.ARC_ANVIL_URL || "http://127.0.0.1:8646", chainId: 31337 },
    arcTestnet: {
      url: process.env.ARC_TESTNET_RPC_URL || "https://rpc.testnet.arc.io",
      chainId: 5042002,
      accounts,
    },
    arcMainnet: {
      url: process.env.ARC_MAINNET_RPC_URL || "https://rpc.mainnet.arc.io",
      chainId: 5042,
      accounts,
    },
  },
  // Arc's explorers run Blockscout, which speaks the Etherscan-style API. The key is not checked.
  etherscan: {
    apiKey: { arcTestnet: "blockscout", arcMainnet: "blockscout" },
    customChains: [
      {
        network: "arcTestnet",
        chainId: 5042002,
        urls: { apiURL: "https://explorer.testnet.arc.io/api", browserURL: "https://explorer.testnet.arc.io" },
      },
      {
        network: "arcMainnet",
        chainId: 5042,
        urls: { apiURL: "https://explorer.arc.io/api", browserURL: "https://explorer.arc.io" },
      },
    ],
  },
  sourcify: { enabled: false },
  mocha: { timeout: 180000 },
};
