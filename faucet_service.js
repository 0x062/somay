// faucet_service.js
// Berisi fungsi inti untuk melakukan klaim ke API Faucet Somnia.

const axios = require('axios');
// SocksProxyAgent tidak benar-benar dibutuhkan jika kita tidak akan pernah passing proxy dari somnia_master_script.js
// Namun, kita bisa biarkan untuk konsistensi dengan fungsi asli jika proxy = null ditangani dengan baik.
// const { SocksProxyAgent } = require('socks-proxy-agent'); 

async function claimFaucet(address, proxy = null) { // proxy akan selalu null dari somnia_master_script.js
  let agent;
  // Logika 'agent' ini tidak akan terpakai jika proxy selalu null.
  // if (proxy) {
  //   agent = new SocksProxyAgent(proxy);
  // }

  const config = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0' // Contoh User-Agent
    }
  };

  // if (agent) {
  //   config.httpAgent = agent;
  //   config.httpsAgent = agent;
  // }

  try {
    const response = await axios.post(
      'https://testnet.somnia.network/api/faucet', // URL API Faucet Somnia
      { address }, // Body request berisi alamat wallet
      config
    );

    // Cek jika respons sukses (status code 200-299)
    if (response.status >= 200 && response.status < 300) {
      return response.data; // Kembalikan data dari respons API
    } else {
      // Jika status code di luar 2xx, buat error custom
      const err = new Error(`Permintaan Faucet API gagal dengan status ${response.status}`);
      err.code = response.status;
      err.data = response.data;
      throw err;
    }
  } catch (error) {
    // Tangani error dari axios atau error custom di atas
    if (error.response) { // Error yang memiliki respons dari server (misalnya 4xx, 5xx)
      const err = new Error(`Faucet API error: Status ${error.response.status}`);
      err.code = error.response.status;
      err.data = error.response.data; // Data error dari server
      throw err;
    } else if (error.request) { // Request dibuat tapi tidak ada respons dari server
      const err = new Error('Tidak ada respons dari API Faucet setelah request dikirim.');
      err.code = 'NO_RESPONSE'; // Kode error custom
      throw err;
    } else { // Error lain saat membuat request (misalnya masalah jaringan sebelum request terkirim)
      const err = new Error(`Error saat setup request ke Faucet API: ${error.message}`);
      err.code = 'REQUEST_SETUP_ERROR'; // Kode error custom
      throw err;
    }
  }
}

module.exports = {
  claimFaucet
};
