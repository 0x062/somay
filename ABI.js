// actions/SomniaSwap/ABI.js (atau path yang sesuai)
// Jika alamat kontrak dimuat dari .env melalui chain.js, Anda bisa impor chain.js di sini
// const chainConfig = require('../../utils/chain'); // Sesuaikan path

// Sebaiknya alamat kontrak juga dikelola melalui .env atau file konfigurasi terpusat
const PONG_CONTRACT_ADDRESS = process.env.NODE_PONG_CONTRACT_ADDRESS || "0xPONG_CONTRACT_ADDRESS_ANDA";
const PING_CONTRACT_ADDRESS = process.env.NODE_PING_CONTRACT_ADDRESS || "0xPING_CONTRACT_ADDRESS_ANDA";
const ROUTER_CONTRACT_ADDRESS = process.env.NODE_ROUTER_CONTRACT_ADDRESS || "0xROUTER_CONTRACT_ADDRESS_ANDA";

const ROUTER_ABI = [
  // Contoh ABI untuk Uniswap V3 exactInputSingle
  // Pastikan ini sesuai dengan ABI router yang Anda gunakan
  {
    "inputs": [
      {
        "components": [
          { "internalType": "address", "name": "tokenIn", "type": "address" },
          { "internalType": "address", "name": "tokenOut", "type": "address" },
          { "internalType": "uint24", "name": "fee", "type": "uint24" },
          { "internalType": "address", "name": "recipient", "type": "address" },
          { "internalType": "uint256", "name": "deadline", "type": "uint256" },
          { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
          { "internalType": "uint256", "name": "amountOutMinimum", "type": "uint256" },
          { "internalType": "uint160", "name": "sqrtPriceLimitX96", "type": "uint160" }
        ],
        "internalType": "struct ISwapRouter.ExactInputSingleParams",
        "name": "params",
        "type": "tuple"
      }
    ],
    "name": "exactInputSingle",
    "outputs": [
      { "internalType": "uint256", "name": "amountOut", "type": "uint256" }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  // Tambahkan fungsi ABI lain yang mungkin dibutuhkan oleh router Anda
];

const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function transfer(address recipient, uint256 amount) external returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)"
];

module.exports = {
  ROUTER_ABI,
  ERC20_ABI,
  PONG_CONTRACT: PONG_CONTRACT_ADDRESS,
  PING_CONTRACT: PING_CONTRACT_ADDRESS,
  ROUTER_CONTRACT: ROUTER_CONTRACT_ADDRESS,
};
