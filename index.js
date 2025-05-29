// misal: actions/SomniaSwap/random.js
require('dotenv').config();

const { ethers } = require('ethers');
const colors = require('colors');

// Impor konfigurasi dan ABI
// Pastikan path ini benar relatif terhadap lokasi random.js
const chainConfig = require('./chain.js');
const { ROUTER_ABI, ERC20_ABI, PONG_CONTRACT, PING_CONTRACT, ROUTER_CONTRACT } = require('./ABI.js');

// --- KONFIGURASI WALLET TUNGGAL (diambil dari .env) ---
const SINGLE_WALLET_PRIVATE_KEY = process.env.NODE_PRIVATE_KEY;
const WALLET_ID = 'AutoSwapWallet-01'; // Nama wallet untuk logging

// --- KONFIGURASI SWAP ---
const MIN_SWAP_PERCENTAGE = 0.05; // 5% dari saldo token sumber
const MAX_SWAP_PERCENTAGE = 0.15; // 15% dari saldo token sumber
const SWAP_AMOUNT_DECIMAL_PRECISION = 6; // Jumlah desimal untuk toFixed() sebelum parseUnits
const NUM_SWAPS_PER_RUN = parseInt(process.env.NODE_NUM_SWAPS_PER_RUN || String(Math.floor(Math.random() * (10 - 5 + 1)) + 5)); // Jumlah swap (5-10) per eksekusi skrip
const DELAY_BETWEEN_SWAPS_BASE_SECONDS = parseInt(process.env.NODE_DELAY_SWAPS_BASE_SECONDS || '10'); // Jeda dasar
const DELAY_BETWEEN_SWAPS_RANDOM_SECONDS = parseInt(process.env.NODE_DELAY_SWAPS_RANDOM_SECONDS || '10'); // Jeda acak tambahan
const SLIPPAGE_PERCENTAGE = parseFloat(process.env.NODE_SLIPPAGE_PERCENTAGE || '0.5'); // Slippage 0.5%

// Validasi konfigurasi penting
if (!SINGLE_WALLET_PRIVATE_KEY || SINGLE_WALLET_PRIVATE_KEY === 'MASUKKAN_PRIVATE_KEY_ANDA_DI_SINI') {
  console.error('🔴 FATAL: NODE_PRIVATE_KEY tidak ditemukan atau belum diatur di file .env'.red);
  process.exit(1);
}
if (!chainConfig.RPC_URL) {
  console.error('🔴 FATAL: NODE_RPC_URL tidak ditemukan atau belum diatur di file .env (melalui chain.js)'.red);
  process.exit(1);
}
if (!PONG_CONTRACT || !PING_CONTRACT || !ROUTER_CONTRACT || PONG_CONTRACT.includes("0xPONG") || PING_CONTRACT.includes("0xPING") || ROUTER_CONTRACT.includes("0xROUTER")) {
  console.warn('🟡 PERINGATAN: Satu atau lebih alamat kontrak (PONG, PING, ROUTER) tampaknya menggunakan placeholder. Pastikan sudah benar di ABI.js atau .env.'.yellow);
}


const provider = new ethers.providers.JsonRpcProvider(chainConfig.RPC_URL, chainConfig.CHAIN_ID || undefined); // CHAIN_ID opsional jika RPC mendukung deteksi otomatis

const tokens = [
  { name: 'PONG', address: PONG_CONTRACT }, // Sebaiknya nama diambil dari tokenContract.symbol()
  { name: 'PING', address: PING_CONTRACT }  // Sebaiknya nama diambil dari tokenContract.symbol()
];

// Cache untuk desimal token
const tokenDecimalsCache = {};
const tokenSymbolCache = {};

async function getTokenInfo(tokenAddress, signerOrProvider) {
  if (!tokenDecimalsCache[tokenAddress] || !tokenSymbolCache[tokenAddress]) {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signerOrProvider);
    try {
        tokenDecimalsCache[tokenAddress] = await tokenContract.decimals();
        tokenSymbolCache[tokenAddress] = await tokenContract.symbol();
    } catch (e) {
        console.error(` Gagal mendapatkan info (decimals/symbol) untuk token ${tokenAddress}: ${e.message}`.red);
        // Fallback ke nama dari array `tokens` jika gagal
        const tokenConfig = tokens.find(t => t.address.toLowerCase() === tokenAddress.toLowerCase());
        tokenSymbolCache[tokenAddress] = tokenConfig ? tokenConfig.name : 'UNKNOWN_TOKEN';
        tokenDecimalsCache[tokenAddress] = 18; // Default ke 18 jika gagal, ini asumsi!
    }
  }
  return { decimals: tokenDecimalsCache[tokenAddress], symbol: tokenSymbolCache[tokenAddress] };
}

async function getTokenBalance(tokenAddress, walletAddress, signerOrProvider) {
  const { decimals, symbol } = await getTokenInfo(tokenAddress, signerOrProvider);
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signerOrProvider);
  const rawBalance = await tokenContract.balanceOf(walletAddress);
  return {
    formatted: Number(ethers.utils.formatUnits(rawBalance, decimals)),
    raw: rawBalance,
    decimals,
    symbol
  };
}

async function checkAndApproveToken(tokenAddress, tokenSymbol, signer, amountNeededBN) {
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const owner = await signer.getAddress();
  const allowance = await tokenContract.allowance(owner, ROUTER_CONTRACT);

  if (allowance.gte(amountNeededBN)) {
    console.log(`👍 [${tokenSymbol}] sudah cukup di-approve untuk Router.`.cyan);
    return true;
  }
  console.log(`🔥 Meng-approve [${tokenSymbol}] sejumlah ${ethers.utils.formatUnits(amountNeededBN, (await getTokenInfo(tokenAddress,signer)).decimals )} agar bisa digunakan oleh Router...`.yellow);
  try {
    // Approve jumlah yang sedikit lebih besar atau MaxUint256
    // Menggunakan MaxUint256 lebih umum untuk DEX, tapi approve jumlah spesifik lebih aman jika sering ganti router
    const approveAmount = ethers.constants.MaxUint256;
    // const approveAmount = amountNeededBN.mul(2); // atau amountNeededBN.add(ethers.utils.parseUnits("1", tokenDecimals));

    const tx = await tokenContract.approve(ROUTER_CONTRACT, approveAmount, {
        // gasPrice: ethers.utils.parseUnits('5', 'gwei'), // Contoh pengaturan gas manual
        // gasLimit: 100000 // Contoh gas limit manual
    });
    console.log(`⏳ Menunggu konfirmasi approval [${tokenSymbol}]... Tx: ${chainConfig.TX_EXPLORER}${tx.hash}`.gray);
    await tx.wait(1); // Tunggu 1 konfirmasi
    console.log(`✅ [${tokenSymbol}] berhasil di-approve untuk Router.`.green);
    await new Promise(res => setTimeout(res, 2000 + Math.random() * 1000)); // Jeda singkat setelah approval
    return true;
  } catch (error) {
    console.error(`❌ Gagal approve [${tokenSymbol}]: ${error.message}`.red);
    if (error.transactionHash) {
        console.error(`   Link approval gagal: ${chainConfig.TX_EXPLORER}${error.transactionHash}`.red)
    }
    return false; // Kembalikan false jika approval gagal
  }
}

async function performContinuousSwaps() {
  const signer = new ethers.Wallet(SINGLE_WALLET_PRIVATE_KEY, provider);
  const walletAddress = await signer.getAddress();
  console.log(`\n🚀 Memulai proses swap untuk Wallet [${WALLET_ID}] - ${walletAddress}\n`.green);

  try {
    const nativeBalanceBN = await provider.getBalance(walletAddress);
    if (nativeBalanceBN.lt(ethers.utils.parseEther("0.001"))) { // Periksa saldo native minimal (contoh 0.001)
      console.warn(`🟡 PERINGATAN: Saldo mata uang native (${chainConfig.NATIVE_CURRENCY_SYMBOL}) rendah: ${ethers.utils.formatEther(nativeBalanceBN)}. Mungkin tidak cukup untuk biaya gas.`.yellow);
    } else {
      console.log(`💰 Saldo Native: ${ethers.utils.formatEther(nativeBalanceBN)} ${chainConfig.NATIVE_CURRENCY_SYMBOL}`.cyan);
    }
  } catch (e) {
    console.error(` Gagal mendapatkan saldo native: ${e.message}`.red);
    return; // Keluar jika tidak bisa cek saldo native
  }


  // Pre-fetch info untuk kedua token
  const tokenInfo0 = await getTokenInfo(tokens[0].address, signer);
  const tokenInfo1 = await getTokenInfo(tokens[1].address, signer);
  tokens[0].name = tokenInfo0.symbol; // Update nama token dari kontrak
  tokens[1].name = tokenInfo1.symbol;

  let initialBalanceToken0 = (await getTokenBalance(tokens[0].address, walletAddress, signer)).formatted;
  let initialBalanceToken1 = (await getTokenBalance(tokens[1].address, walletAddress, signer)).formatted;

  if (initialBalanceToken0 === 0 && initialBalanceToken1 === 0) {
    console.log(`⚠️ Wallet [${WALLET_ID}] tidak memiliki saldo ${tokens[0].name} atau ${tokens[1].name} untuk diswap.`.red);
    return;
  }
  console.log(`Saldo Awal - ${tokens[0].name}: ${initialBalanceToken0.toFixed(SWAP_AMOUNT_DECIMAL_PRECISION)}, ${tokens[1].name}: ${initialBalanceToken1.toFixed(SWAP_AMOUNT_DECIMAL_PRECISION)}`.blue);
  console.log(`💼 Akan melakukan ${NUM_SWAPS_PER_RUN} swap pada sesi ini dengan slippage ${SLIPPAGE_PERCENTAGE}%.`.blue);

  for (let i = 1; i <= NUM_SWAPS_PER_RUN; i++) {
    console.log(`\n🔄 Swap ke-${i} dari ${NUM_SWAPS_PER_RUN}`.yellow);

    const currentBalToken0 = (await getTokenBalance(tokens[0].address, walletAddress, signer)).formatted;
    const currentBalToken1 = (await getTokenBalance(tokens[1].address, walletAddress, signer)).formatted;

    // Alternasi arah swap: Prioritaskan jual token yang saldonya lebih banyak (dalam unit, bukan nilai USD)
    // Ini adalah heuristik sederhana, bisa disesuaikan
    const swapDirection = (currentBalToken0 > currentBalToken1 && currentBalToken0 > 0) ? 0 : (currentBalToken1 > 0 ? 1 : -1) ;

    if (swapDirection === -1) {
        console.log(`⚠️ Saldo kedua token (${tokens[0].name} dan ${tokens[1].name}) adalah nol atau sangat rendah. Menghentikan swap.`.red);
        return;
    }
    
    const tokenA = tokens[swapDirection]; // Token yang akan dijual
    const tokenB = tokens[swapDirection === 0 ? 1 : 0]; // Token yang akan dibeli
    const balanceA = swapDirection === 0 ? currentBalToken0 : currentBalToken1;

    console.log(`Saldo ${tokenA.name} saat ini: ${balanceA.toFixed(SWAP_AMOUNT_DECIMAL_PRECISION)}`.cyan);

    if (balanceA === 0) {
      console.log(`⚠️ Tidak ada saldo ${tokenA.name} untuk diswap. Iterasi ini dilewati.`.yellow);
      await new Promise(res => setTimeout(res, 1000));
      continue;
    }

    const percentageToSwap = (Math.random() * (MAX_SWAP_PERCENTAGE - MIN_SWAP_PERCENTAGE)) + MIN_SWAP_PERCENTAGE;
    let amountToSwapNum = Number((balanceA * percentageToSwap).toFixed(SWAP_AMOUNT_DECIMAL_PRECISION));

    if (amountToSwapNum <= 0) {
      console.log(`⚠️ Jumlah ${tokenA.name} yang akan diswap terlalu kecil atau nol (${amountToSwapNum}). Melewati swap ini.`.yellow);
      await new Promise(res => setTimeout(res, 1000));
      continue;
    }
    
    const decimalsA = (await getTokenInfo(tokenA.address, signer)).decimals;
    const amountInBN = ethers.utils.parseUnits(amountToSwapNum.toString(), decimalsA);

    if (amountInBN.isZero()) {
        console.log(`⚠️ Jumlah ${amountToSwapNum} ${tokenA.name} menghasilkan BigNumber nol setelah parseUnits (terlalu kecil). Melewati.`.yellow);
        await new Promise(res => setTimeout(res, 1000));
        continue;
    }
    
    console.log(`✨ Akan menukar: ${amountToSwapNum.toFixed(SWAP_AMOUNT_DECIMAL_PRECISION)} ${tokenA.name} menjadi ${tokenB.name}`.magenta);

    try {
      const approved = await checkAndApproveToken(tokenA.address, tokenA.name, signer, amountInBN);
      if (!approved) {
          console.log(` Gagal melakukan approval untuk ${tokenA.name}, swap dibatalkan untuk iterasi ini.`.red);
          await new Promise(res => setTimeout(res, (DELAY_BETWEEN_SWAPS_BASE_SECONDS + Math.random() * DELAY_BETWEEN_SWAPS_RANDOM_SECONDS) * 1000));
          continue;
      }

      const routerContract = new ethers.Contract(ROUTER_CONTRACT, ROUTER_ABI, signer);
      
      // Hitung deadline (misalnya 10 menit dari sekarang)
      const deadline = Math.floor(Date.now() / 1000) + (10 * 60); 

      const swapParamsBase = {
        tokenIn: tokenA.address,
        tokenOut: tokenB.address,
        fee: 500, // Fee tier Uniswap V3, sesuaikan jika perlu. Untuk DEX lain mungkin tidak ada.
        recipient: walletAddress,
        deadline: deadline,
        amountIn: amountInBN,
        amountOutMinimum: ethers.BigNumber.from(0), // Akan diisi setelah simulasi
        sqrtPriceLimitX96: 0  // Biasanya 0 untuk tidak ada batasan harga (Uniswap V3)
      };

      let expectedAmountOutBN;
      try {
        console.log(`📡 Mensimulasikan swap...`.gray);
        expectedAmountOutBN = await routerContract.callStatic.exactInputSingle(swapParamsBase
            // , { from: walletAddress } // Beberapa node/RPC mungkin butuh 'from' untuk callStatic
        );
        const decimalsB = (await getTokenInfo(tokenB.address, signer)).decimals;
        const expectedOutFormatted = ethers.utils.formatUnits(expectedAmountOutBN, decimalsB);
        console.log(`💡 Simulasi Sukses: Akan mendapatkan ~${parseFloat(expectedOutFormatted).toFixed(SWAP_AMOUNT_DECIMAL_PRECISION)} ${tokenB.name}`.green);

        // Hitung amountOutMinimum berdasarkan slippage
        const slippageFactor = ethers.BigNumber.from(Math.floor(SLIPPAGE_PERCENTAGE * 100)); // misal 0.5% -> 50
        const हंड्रेड_PERCENT_FACTOR = ethers.BigNumber.from(10000); // 100.00%
        swapParamsBase.amountOutMinimum = expectedAmountOutBN.mul(हंड्रेड_PERCENT_FACTOR.sub(slippageFactor)).div(हंड्रेड_PERCENT_FACTOR);
        console.log(`   Dengan slippage ${SLIPPAGE_PERCENTAGE}%, amountOutMinimum: ${ethers.utils.formatUnits(swapParamsBase.amountOutMinimum, decimalsB)} ${tokenB.name}`.blue);

      } catch (simError) {
        console.error(`❌ Gagal simulasi swap (${tokenA.name} -> ${tokenB.name}):`.red, simError.reason || simError.message || simError);
        if (simError.code === 'CALL_EXCEPTION' || (simError.error?.message?.includes("failed")) || (simError.data?.message?.includes("failed")) || (simError.message?.includes("execution reverted")) ) {
            console.log(`    Simulasi mengindikasikan swap kemungkinan besar akan gagal. Melewati eksekusi swap aktual.`.yellow);
        } else {
            console.log(`    Gagal simulasi dengan alasan tidak terduga, namun tetap mencoba eksekusi (hati-hati).`.yellow);
            // Jika tidak yakin, lebih baik tidak melanjutkan:
            // await new Promise(res => setTimeout(res, (DELAY_BETWEEN_SWAPS_BASE_SECONDS + Math.random() * DELAY_BETWEEN_SWAPS_RANDOM_SECONDS) * 1000));
            // continue;
        }
        // Jika simulasi gagal, amountOutMinimum tetap 0 (atau nilai default), ini berisiko.
        // Pertimbangkan untuk tidak melanjutkan jika simulasi gagal.
        // Untuk contoh ini, kita coba lanjutkan dengan amountOutMinimum yang mungkin masih 0 jika simulasi error parah.
        // Idealnya: jika simulasi gagal, jangan lanjutkan atau gunakan amountOutMinimum yang sangat konservatif.
         if(!expectedAmountOutBN) { // Jika expectedAmountOutBN tidak berhasil didapat
            console.log(`    Karena simulasi gagal mendapatkan expectedAmountOut, swap dibatalkan untuk keamanan.`.red);
            await new Promise(res => setTimeout(res, (DELAY_BETWEEN_SWAPS_BASE_SECONDS + Math.random() * DELAY_BETWEEN_SWAPS_RANDOM_SECONDS) * 1000));
            continue;
         }
      }
      
      console.log(`🚀 Mengeksekusi Swap: ${amountToSwapNum.toFixed(SWAP_AMOUNT_DECIMAL_PRECISION)} ${tokenA.name} -> ${tokenB.name}...`.yellow);
      const tx = await routerContract.exactInputSingle(swapParamsBase, {
        // gasPrice: await provider.getGasPrice(), // atau atur manual
        // gasLimit: ethers.utils.hexlify(300000) // estimasi atau atur manual
      });
      console.log(`🔗 Transaksi Swap Terkirim! Hash: ${chainConfig.TX_EXPLORER}${tx.hash}`.magenta);
      const receipt = await tx.wait(1); // Tunggu 1 konfirmasi
      console.log(`✅ Transaksi Terkonfirmasi! Blok: ${receipt.blockNumber}. Gas terpakai: ${receipt.gasUsed.toString()}`.green);
      
      const postSwapA = (await getTokenBalance(tokenA.address, walletAddress, signer)).formatted;
      const postSwapB = (await getTokenBalance(tokenB.address, walletAddress, signer)).formatted;
      console.log(`⚡ Saldo Setelah Swap: ${tokenA.name}: ${postSwapA.toFixed(SWAP_AMOUNT_DECIMAL_PRECISION)}, ${tokenB.name}: ${postSwapB.toFixed(SWAP_AMOUNT_DECIMAL_PRECISION)}`.cyan);

    } catch (error) {
      console.error(`❌ Gagal total pada proses swap (${tokenA.name} -> ${tokenB.name}):`.red);
      if (error.reason) console.error(`   Reason: ${error.reason}`.red);
      if (error.code) console.error(`   Code: ${error.code}`.red);
      if (error.transactionHash) {
        console.error(`   Link transaksi gagal: ${chainConfig.TX_EXPLORER}${error.transactionHash}`.red);
      } else if (error.message) {
        console.error(`   Message: ${error.message}`.red);
      } else {
        console.error("   Error object:", error)
      }
    }
    
    const actualDelay = (DELAY_BETWEEN_SWAPS_BASE_SECONDS + Math.random() * DELAY_BETWEEN_SWAPS_RANDOM_SECONDS) * 1000;
    console.log(`⏳ Menunggu ${Math.round(actualDelay/1000)} detik sebelum tindakan berikutnya...`);
    await new Promise(res => setTimeout(res, actualDelay));
  }
}

async function main() {
  console.log(colors.bold.blue("Memulai Skrip AutoSwap Mandiri..."));
  console.log(colors.gray(`Waktu saat ini: ${new Date().toLocaleString()}`));
  await performContinuousSwaps();
  console.log(colors.bold.green('\nSemua swap yang direncanakan untuk sesi ini telah selesai!'));
  console.log(colors.gray(`Waktu selesai: ${new Date().toLocaleString()}`));
}

// Menjalankan fungsi main dan menangani error global
main().catch(error => {
  console.error("🛑 ERROR FATAL PADA FUNGSI main LUAR:".red);
  if (error.reason) console.error(`   Reason: ${error.reason}`.red);
  if (error.code) console.error(`   Code: ${error.code}`.red);
  if (error.message) console.error(`   Message: ${error.message}`.red);
  else console.error(error);
  process.exit(1);
});
