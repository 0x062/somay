require('dotenv').config();
const { sendReport } = require('./telegramReporter');
const { claimFaucet } = require('./faucet_service.js'); 
const { ethers } = require('ethers');
const colors = require('colors');

// --- BAGIAN 1: KONFIGURASI JARINGAN (Sebelumnya di chain.js) ---
const CHAIN_CONFIG = {
  RPC_URL: process.env.NODE_RPC_URL || "https://dream-rpc.somnia.network/", // Ambil dari .env atau default
  CHAIN_ID: 50312,
  SYMBOL: "STT",
  TX_EXPLORER: "https://shannon-explorer.somnia.network/tx/",
  ADDRESS_EXPLORER: "https://shannon-explorer.somnia.network/address/",
};

// --- BAGIAN 2: ALAMAT KONTRAK & ABI (Sebelumnya di ABI.js) ---
const CONTRACT_ADDRESSES = {
  QUOTER: "0x27a1e87aed9949808a7c6db733ad1cd96e365d9e", // Tidak digunakan di skrip ini, tapi ada untuk referensi
  PONG: "0x7968ac15a72629E05F41B8271e4e7292E0cC9f90",
  PING: "0xBeCd9B5F373877881D91cBdBaF013D97eB532154",
  ROUTER: "0x6AAC14f090A35EeA150705f72D90E4CDC4a49b2C",
};

// ABI Utama (berisi fungsi mint, exactInputSingle, dll.)
const ALL_CONTRACT_FUNCTIONS_ABI = [
  // exactInputSingle (digunakan untuk swapping)
  {
    "inputs": [
      {
        "components": [
          { "internalType": "address", "name": "tokenIn", "type": "address" },
          { "internalType": "address", "name": "tokenOut", "type": "address" },
          { "internalType": "uint24", "name": "fee", "type": "uint24" },
          { "internalType": "address", "name": "recipient", "type": "address" },
          // Tidak ada 'deadline' di sini sesuai ABI Anda
          { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
          { "internalType": "uint256", "name": "amountOutMinimum", "type": "uint256" },
          { "internalType": "uint160", "name": "sqrtPriceLimitX96", "type": "uint160" }
        ],
        "internalType": "struct IExactInputSingleParams", // Nama struct dari ABI Anda
        "name": "params",
        "type": "tuple"
      }
    ],
    "name": "exactInputSingle",
    "outputs": [ { "internalType": "uint256", "name": "amountOut", "type": "uint256" } ],
    "stateMutability": "payable",
    "type": "function"
  },
  // mint(address to, uint256 amount) (digunakan untuk minting PONG & PING)
  {
    "inputs": [
      { "internalType": "address", "name": "to", "type": "address" },
      { "internalType": "uint256", "name": "amount", "type": "uint256" }
    ],
    "name": "mint",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
  // Anda bisa menambahkan ABI fungsi lain dari ROUTER jika diperlukan di sini
];

// ABI Lokal untuk fungsi ERC20 standar yang sering digunakan
const LOCAL_ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)"
];

// --- BAGIAN 3: KONFIGURASI SKRIP UTAMA (dari .env atau default) ---
const SINGLE_WALLET_PRIVATE_KEY = process.env.NODE_PRIVATE_KEY;
const WALLET_ID = 'SomniaMasterWallet';

const MINT_AMOUNT_TOKENS_STR = process.env.NODE_MINT_AMOUNT_TOKENS || "1000"; // Jumlah "utuh" per token

const MIN_SWAP_PERCENTAGE = parseFloat(process.env.NODE_MIN_SWAP_PERCENTAGE || '0.05');
const MAX_SWAP_PERCENTAGE = parseFloat(process.env.NODE_MAX_SWAP_PERCENTAGE || '0.15');
const SWAP_AMOUNT_DECIMAL_PRECISION = 6;
const NUM_SWAPS_PER_RUN = parseInt(process.env.NODE_NUM_SWAPS_PER_RUN || String(Math.floor(Math.random() * (10 - 5 + 1)) + 5));
const DELAY_BETWEEN_ACTIONS_BASE_SECONDS = parseInt(process.env.NODE_DELAY_ACTIONS_BASE_SECONDS || '10');
const DELAY_BETWEEN_ACTIONS_RANDOM_SECONDS = parseInt(process.env.NODE_DELAY_ACTIONS_RANDOM_SECONDS || '5');
const SLIPPAGE_PERCENTAGE = parseFloat(process.env.NODE_SLIPPAGE_PERCENTAGE || '0.5');

// Validasi konfigurasi penting
if (!SINGLE_WALLET_PRIVATE_KEY || SINGLE_WALLET_PRIVATE_KEY === 'MASUKKAN_PRIVATE_KEY_ANDA_DI_SINI') {
  console.error('🔴 FATAL: NODE_PRIVATE_KEY tidak ditemukan atau belum diatur di file .env'.red);
  process.exit(1);
}
if (!CHAIN_CONFIG.RPC_URL || !CHAIN_CONFIG.RPC_URL.startsWith("http")) {
  console.error('🔴 FATAL: RPC_URL tidak valid. Pastikan diatur di .env atau di skrip.'.red);
  process.exit(1);
}

const provider = new ethers.providers.JsonRpcProvider(CHAIN_CONFIG.RPC_URL, CHAIN_CONFIG.CHAIN_ID);
const tokensToManage = []; // Akan diisi [ { address, symbol, decimals }, ... ]

// Cache
const tokenInfoCache = {};

// --- BAGIAN 4: FUNGSI HELPER ---
async function getTokenInfo(tokenAddress, signerOrProvider) {
  const addressLower = tokenAddress.toLowerCase();
  if (tokenInfoCache[addressLower]) {
    return tokenInfoCache[addressLower];
  }
  const tokenContract = new ethers.Contract(tokenAddress, LOCAL_ERC20_ABI, signerOrProvider);
  let decimals = 18; // Default
  let symbol = 'UNKNOWN';
  try {
    decimals = await tokenContract.decimals();
    symbol = await tokenContract.symbol();
  } catch (e) {
    console.warn(` Gagal mendapatkan info (decimals/symbol) untuk token ${tokenAddress}. Error: ${e.message}`.yellow);
    if (addressLower === CONTRACT_ADDRESSES.PONG.toLowerCase()) symbol = 'PONG';
    else if (addressLower === CONTRACT_ADDRESSES.PING.toLowerCase()) symbol = 'PING';
  }
  const info = { decimals, symbol, address: tokenAddress };
  tokenInfoCache[addressLower] = info;
  return info;
}

async function getTokenBalance(tokenAddress, walletAddress, signerOrProvider) {
  const { decimals, symbol } = await getTokenInfo(tokenAddress, signerOrProvider);
  const tokenContract = new ethers.Contract(tokenAddress, LOCAL_ERC20_ABI, signerOrProvider);
  const rawBalance = await tokenContract.balanceOf(walletAddress);
  return {
    formatted: Number(ethers.utils.formatUnits(rawBalance, decimals)),
    raw: rawBalance,
    decimals,
    symbol
  };
}

// --- BAGIAN BARU: FUNGSI KLAIM FAUCET ---
async function performFaucetClaim(signer, walletAddress) {
  console.log(colors.cyan("\n--- Memulai Fase Klaim Faucet ---"));
  console.log(`🚀 Mengajukan Klaim Faucet Untuk Wallet - [${WALLET_ID}] ${walletAddress}`);

  try {
    const apiResponse = await claimFaucet(walletAddress, null); // Memanggil fungsi yang diimpor
    
    let responseString = "";
    if (typeof apiResponse === 'string') {
        responseString = apiResponse;
    } else if (apiResponse && typeof apiResponse === 'object') {
        responseString = JSON.stringify(apiResponse);
    } else if (apiResponse !== undefined && apiResponse !== null) {
        responseString = String(apiResponse);
    }

    console.log(`✅ Faucet Berhasil Diklaim untuk Wallet - [${walletAddress}]`);
    if (responseString) {
      console.log(`🔗 Respons API: ${responseString}`);
    }

  } catch (error) {
    const code = error.code || 'N/A';
    let errorMessage = 'Detail error tidak tersedia.';
    if (error.response && error.response.data) { 
        errorMessage = JSON.stringify(error.response.data);
    } else if (error.data) { 
        errorMessage = JSON.stringify(error.data);
    } else if (error.message) {
        errorMessage = error.message;
    } else {
        try { errorMessage = JSON.stringify(error); } catch (e) { errorMessage = String(error); }
    }
    console.log(`⚠️  Permintaan Faucet Gagal dengan kode - [${code}]`.red);
    console.log(`   Respons API/Error: ${errorMessage}`.red);
  }
  console.log(colors.blue("--- Fase Klaim Faucet Selesai ---"));
}

// --- BAGIAN 5: FUNGSI MINTING ---
async function performMinting(signer, walletAddress) {
  console.log(colors.cyan("\n--- Memulai Fase Minting Token ---"));
  const mintAbiFragment = ALL_CONTRACT_FUNCTIONS_ABI.find(item => item.name === 'mint' && item.type === 'function' && item.inputs.length === 2);
  if (!mintAbiFragment) {
    console.error(" Fungsi 'mint(address, uint256)' tidak ditemukan dalam ALL_CONTRACT_FUNCTIONS_ABI.".red);
    return false;
  }

  let allMintsSuccessful = true;
  for (const tokenConfig of tokensToManage) {
    try {
      console.log(`\nMencoba mint [${tokenConfig.symbol}] ke ${walletAddress}...`.blue);
      const MINT_AMOUNT_BN = ethers.utils.parseUnits(MINT_AMOUNT_TOKENS_STR, tokenConfig.decimals);
      const contract = new ethers.Contract(tokenConfig.address, [mintAbiFragment], signer);

      const block = await provider.getBlock('latest');
      if (!block || !block.baseFeePerGas) {
        console.error(' Tidak dapat mengambil baseFeePerGas dari blok terbaru.'.red);
        allMintsSuccessful = false; continue;
      }
      const gasPriceSuggestion = block.baseFeePerGas.mul(120).div(100); // base + 20%
      const txOptions = {
        maxFeePerGas: gasPriceSuggestion,
        maxPriorityFeePerGas: ethers.utils.parseUnits("1", "gwei"), // Tip 1 Gwei
      };
      
      try {
        const estimatedGas = await contract.estimateGas.mint(walletAddress, MINT_AMOUNT_BN); // Hapus txOptions dari estimateGas jika menyebabkan error
        txOptions.gasLimit = estimatedGas.mul(120).div(100);
        console.log(` Estimasi gas untuk mint ${tokenConfig.symbol}: ${txOptions.gasLimit.toString()}`);
      } catch (estError) {
        console.warn(` Gagal estimasi gas mint ${tokenConfig.symbol}, menggunakan default 200000. Error: ${estError.message}`.yellow);
        txOptions.gasLimit = ethers.utils.hexlify(200000);
      }

      console.log(`⚙️  Tx Mint untuk [${tokenConfig.symbol}] (${MINT_AMOUNT_TOKENS_STR} ${tokenConfig.symbol}) ...`);
      const tx = await contract.mint(walletAddress, MINT_AMOUNT_BN, txOptions);
      console.log(`🔗 Tx Mint Terkirim! ${CHAIN_CONFIG.TX_EXPLORER}${tx.hash}`.magenta);
      const receipt = await tx.wait(1);
      console.log(`✅ Tx Mint [${tokenConfig.symbol}] Terkonfirmasi! Blok: ${receipt.blockNumber}`.green);
    } catch (err) {
      console.error(`❌ Gagal mint [${tokenConfig.symbol}]: ${err.reason || err.message || err}`.red);
      allMintsSuccessful = false;
    }
    const delay = (DELAY_BETWEEN_ACTIONS_BASE_SECONDS / 2 + Math.random() * DELAY_BETWEEN_ACTIONS_RANDOM_SECONDS / 2) * 1000;
    console.log(`⏳ Jeda ${Math.round(delay/1000)} detik...`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  return allMintsSuccessful;
}

// --- BAGIAN 6: FUNGSI SWAPPING ---
async function checkAndApproveToken(tokenAddress, tokenSymbol, tokenDecimals, signer, amountNeededBN) {
  const tokenContract = new ethers.Contract(tokenAddress, LOCAL_ERC20_ABI, signer);
  const owner = await signer.getAddress();
  const allowance = await tokenContract.allowance(owner, CONTRACT_ADDRESSES.ROUTER);

  if (allowance.gte(amountNeededBN)) {
    console.log(`👍 [${tokenSymbol}] sudah cukup di-approve untuk Router.`);
    return true;
  }
  console.log(`🔥 Meng-approve [${tokenSymbol}] (${ethers.utils.formatUnits(amountNeededBN, tokenDecimals)})...`.yellow);
  try {
    const approveAmount = ethers.constants.MaxUint256;
    const tx = await tokenContract.approve(CONTRACT_ADDRESSES.ROUTER, approveAmount);
    console.log(`⏳ Menunggu approval [${tokenSymbol}]... Tx: ${CHAIN_CONFIG.TX_EXPLORER}${tx.hash}`.gray);
    await tx.wait(1);
    console.log(`✅ [${tokenSymbol}] berhasil di-approve.`);
    await new Promise(res => setTimeout(res, 2000 + Math.random() * 1000));
    return true;
  } catch (error) {
    console.error(`❌ Gagal approve [${tokenSymbol}]: ${error.message}`.red);
    return false;
  }
}

async function performSwapping(signer, walletAddress) {
  console.log(colors.cyan("\n--- Memulai Fase Swapping Token ---"));
  const routerContract = new ethers.Contract(CONTRACT_ADDRESSES.ROUTER, ALL_CONTRACT_FUNCTIONS_ABI, signer);

  for (let i = 1; i <= NUM_SWAPS_PER_RUN; i++) {
    console.log(`\n🔄 Swap ke-${i} dari ${NUM_SWAPS_PER_RUN}`.yellow);

    const balToken0 = await getTokenBalance(tokensToManage[0].address, walletAddress, signer);
    const balToken1 = await getTokenBalance(tokensToManage[1].address, walletAddress, signer);
    
    const swapDirection = (balToken0.formatted > balToken1.formatted && balToken0.formatted > 0.00001) ? 0 : (balToken1.formatted > 0.00001 ? 1 : -1);

    if (swapDirection === -1) {
        console.log(`⚠️ Saldo kedua token (${tokensToManage[0].symbol} & ${tokensToManage[1].symbol}) terlalu rendah. Fase swap berhenti.`.red);
        return;
    }
    
    const tokenA_config = tokensToManage[swapDirection];
    const tokenB_config = tokensToManage[swapDirection === 0 ? 1 : 0];
    const balanceA_formatted = swapDirection === 0 ? balToken0.formatted : balToken1.formatted;

    console.log(`Saldo ${tokenA_config.symbol}: ${balanceA_formatted.toFixed(SWAP_AMOUNT_DECIMAL_PRECISION)}`);

    if (balanceA_formatted <= 0.000001) {
      console.log(`⚠️ Saldo ${tokenA_config.symbol} tidak signifikan. Dilewati.`.yellow);
      await new Promise(res => setTimeout(res, 1000)); continue;
    }

    const percentageToSwap = (Math.random() * (MAX_SWAP_PERCENTAGE - MIN_SWAP_PERCENTAGE)) + MIN_SWAP_PERCENTAGE;
    let amountToSwapNum = Number((balanceA_formatted * percentageToSwap).toFixed(SWAP_AMOUNT_DECIMAL_PRECISION));

    if (amountToSwapNum <= 0) {
      console.log(`⚠️ Jumlah swap ${tokenA_config.symbol} terlalu kecil (${amountToSwapNum}). Dilewati.`.yellow);
      await new Promise(res => setTimeout(res, 1000)); continue;
    }
    
    const amountInBN = ethers.utils.parseUnits(amountToSwapNum.toString(), tokenA_config.decimals);

    if (amountInBN.isZero()) {
        console.log(`⚠️ Jumlah swap ${tokenA_config.symbol} jadi nol (terlalu kecil). Dilewati.`.yellow);
        await new Promise(res => setTimeout(res, 1000)); continue;
    }
    
    console.log(`✨ Akan tukar: ${amountToSwapNum.toFixed(SWAP_AMOUNT_DECIMAL_PRECISION)} ${tokenA_config.symbol} -> ${tokenB_config.symbol}`.magenta);

    try {
      const approved = await checkAndApproveToken(tokenA_config.address, tokenA_config.symbol, tokenA_config.decimals, signer, amountInBN);
      if (!approved) {
          console.log(` Approval ${tokenA_config.symbol} gagal, swap dibatalkan.`.red);
          const delay = (DELAY_BETWEEN_ACTIONS_BASE_SECONDS + Math.random() * DELAY_BETWEEN_ACTIONS_RANDOM_SECONDS) * 1000;
          await new Promise(res => setTimeout(res, delay)); continue;
      }
      
      const swapParams = { // Perhatikan: tidak ada 'deadline'
        tokenIn: tokenA_config.address,
        tokenOut: tokenB_config.address,
        fee: 500, // Sesuaikan fee tier (untuk Uniswap V3 style)
        recipient: walletAddress,
        amountIn: amountInBN,
        amountOutMinimum: ethers.BigNumber.from(0),
        sqrtPriceLimitX96: 0
      };

      let expectedAmountOutBN;
      try {
        console.log(`📡 Mensimulasikan swap...`);
        expectedAmountOutBN = await routerContract.callStatic.exactInputSingle(swapParams);
        const expectedOutFormatted = ethers.utils.formatUnits(expectedAmountOutBN, tokenB_config.decimals);
        console.log(`💡 Simulasi: Dapat ~${parseFloat(expectedOutFormatted).toFixed(SWAP_AMOUNT_DECIMAL_PRECISION)} ${tokenB_config.symbol}`.green);

        const slippageFactor = ethers.BigNumber.from(Math.floor(SLIPPAGE_PERCENTAGE * 100));
        const HUNDRED_PERCENT_FACTOR = ethers.BigNumber.from(10000);
        swapParams.amountOutMinimum = expectedAmountOutBN.mul(HUNDRED_PERCENT_FACTOR.sub(slippageFactor)).div(HUNDRED_PERCENT_FACTOR);
        console.log(`   Slippage ${SLIPPAGE_PERCENTAGE}%, min out: ${ethers.utils.formatUnits(swapParams.amountOutMinimum, tokenB_config.decimals)} ${tokenB_config.symbol}`.blue);

      } catch (simError) {
        console.error(`❌ Gagal simulasi swap (${tokenA_config.symbol} -> ${tokenB_config.symbol}): ${simError.reason || simError.message || simError}`.red);
         if(!expectedAmountOutBN) {
            console.log(`    Simulasi gagal dapat expectedAmountOut, swap dibatalkan.`.red);
            const delay = (DELAY_BETWEEN_ACTIONS_BASE_SECONDS + Math.random() * DELAY_BETWEEN_ACTIONS_RANDOM_SECONDS) * 1000;
            await new Promise(res => setTimeout(res, delay)); continue;
         }
      }
      
      console.log(`🚀 Mengeksekusi Swap...`);
      const tx = await routerContract.exactInputSingle(swapParams);
      console.log(`🔗 Tx Swap Terkirim! ${CHAIN_CONFIG.TX_EXPLORER}${tx.hash}`.magenta);
      const receipt = await tx.wait(1);
      console.log(`✅ Tx Swap Terkonfirmasi! Blok: ${receipt.blockNumber}, Gas: ${receipt.gasUsed.toString()}`.green);
      
      const postSwapA = await getTokenBalance(tokenA_config.address, walletAddress, signer);
      const postSwapB = await getTokenBalance(tokenB_config.address, walletAddress, signer);
      console.log(`⚡ Saldo Setelah Swap: ${tokenA_config.symbol}: ${postSwapA.formatted.toFixed(SWAP_AMOUNT_DECIMAL_PRECISION)}, ${tokenB_config.symbol}: ${postSwapB.formatted.toFixed(SWAP_AMOUNT_DECIMAL_PRECISION)}`);

    } catch (error) {
      console.error(`❌ Gagal total proses swap (${tokenA_config.symbol} -> ${tokenB_config.symbol}): ${error.reason || error.message || error}`.red);
    }
    
    const delay = (DELAY_BETWEEN_ACTIONS_BASE_SECONDS + Math.random() * DELAY_BETWEEN_ACTIONS_RANDOM_SECONDS) * 1000;
    console.log(`⏳ Jeda ${Math.round(delay/1000)} detik...`);
    await new Promise(res => setTimeout(res, delay));
  }
}

// --- BAGIAN 7: FUNGSI UTAMA ORKESTRASI ---
async function main() {
  console.log(colors.bold.blue("===== Memulai Skrip Master Somnia (Mint & Swap) ====="));
  console.log(colors.gray(`Waktu: ${new Date().toLocaleString()}`));

  const signer = new ethers.Wallet(SINGLE_WALLET_PRIVATE_KEY, provider);
  const walletAddress = await signer.getAddress();
  console.log(`Menggunakan Wallet: ${walletAddress} [ID: ${WALLET_ID}]`.yellow);

  // Inisialisasi tokensToManage (PONG dan PING)
  const pongInfo = await getTokenInfo(CONTRACT_ADDRESSES.PONG, signer);
  const pingInfo = await getTokenInfo(CONTRACT_ADDRESSES.PING, signer);
  tokensToManage.push(pongInfo); // pongInfo sudah berisi address, symbol, decimals
  tokensToManage.push(pingInfo);

  try {
    const nativeBalanceBN = await provider.getBalance(walletAddress);
    console.log(`Saldo Native Awal (${CHAIN_CONFIG.SYMBOL}): ${ethers.utils.formatEther(nativeBalanceBN)}`.cyan);
    if (nativeBalanceBN.lt(ethers.utils.parseEther("0.002"))) {
        console.warn(`PERINGATAN: Saldo native rendah. Pastikan cukup untuk semua transaksi.`.yellow)
    }
  } catch (e) {
    console.error(` Gagal mendapatkan saldo native: ${e.message}`.red); return; 
  }
  
  try {
    await performFaucetClaim(signer, walletAddress);
  } catch (error) {
     console.error(colors.red.bold("\n❌ Error Kritis selama Fase Klaim Faucet:"), error);
     // Anda bisa memutuskan apakah akan melanjutkan ke minting/swapping jika faucet gagal
  }
  
  // Jeda setelah faucet claim
  const faucetDelaySeconds = 3 + Math.random()*3; // Jeda 3-6 detik
  console.log(`\n⏳ Jeda ${Math.round(faucetDelaySeconds)} detik setelah klaim faucet...`.gray);
  await new Promise(res => setTimeout(res, faucetDelaySeconds * 1000));

  // ... (lanjutkan dengan langkah Fase Minting, Jeda, Fase Swapping seperti sebelumnya) ...

  // 1. Jalankan Fase Minting
  let mintingDoneSuccessfully = false;
  try {
    mintingDoneSuccessfully = await performMinting(signer, walletAddress);
    if(mintingDoneSuccessfully) {
        console.log(colors.green.bold("\n--- Fase Minting Selesai Sukses ---"));
    } else {
        console.log(colors.yellow.bold("\n--- Fase Minting Selesai (mungkin ada kegagalan, cek log) ---"));
    }
  } catch (error) {
    console.error(colors.red.bold("\n❌ Error Kritis Fase Minting:"), error);
  }

  const midBreakSeconds = 5 + Math.random()*5;
  console.log(`\n⏳ Jeda ${Math.round(midBreakSeconds)} detik sebelum fase swapping...`);
  await new Promise(res => setTimeout(res, midBreakSeconds * 1000));

  // 2. Jalankan Fase Swapping
  try {
    const balPong = await getTokenBalance(CONTRACT_ADDRESSES.PONG, walletAddress, signer);
    const balPing = await getTokenBalance(CONTRACT_ADDRESSES.PING, walletAddress, signer);
    console.log(`Memulai swap dengan saldo: ${balPong.symbol} ${balPong.formatted.toFixed(4)}, ${balPing.symbol} ${balPing.formatted.toFixed(4)}`.blue);
    
    if (balPong.formatted < 0.00001 && balPing.formatted < 0.00001 && !mintingDoneSuccessfully) {
        console.log("Tidak ada token di-mint & saldo awal kosong. Swap tidak dilanjutkan.".yellow);
    } else {
        await performSwapping(signer, walletAddress);
        console.log(colors.green.bold("\n--- Fase Swapping Selesai ---"));
    }
  } catch (error) {
    console.error(colors.red.bold("\n❌ Error Kritis Fase Swapping:"), error);
  }

  console.log(colors.bold.blue("\n===== Skrip Master Somnia Selesai ====="));
  console.log(colors.gray(`Waktu Selesai: ${new Date().toLocaleString()}`));
  await sendReport(`✅ Somnia Swap Selesai !`);
}

main().catch(error => {
  console.error(colors.red.bold("🛑 ERROR FATAL GLOBAL:"), error);
  process.exit(1);
});
