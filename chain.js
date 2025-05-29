// utils/chain.js
require('dotenv').config();

module.exports = {
  RPC_URL: process.env.NODE_RPC_URL,
  CHAIN_ID: parseInt(process.env.NODE_CHAIN_ID || '0', 10), // Default ke 0 jika tidak ada
  TX_EXPLORER: process.env.NODE_TX_EXPLORER || '',
  NATIVE_CURRENCY_SYMBOL: process.env.NODE_NATIVE_CURRENCY_SYMBOL || 'NativeCoin',
  // Anda bisa juga memuat alamat kontrak di sini jika mau
  // PONG_CONTRACT: process.env.NODE_PONG_CONTRACT_ADDRESS,
  // PING_CONTRACT: process.env.NODE_PING_CONTRACT_ADDRESS,
  // ROUTER_CONTRACT: process.env.NODE_ROUTER_CONTRACT_ADDRESS,
};
