const express = require('express');
const helmet = require('helmet');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const db = require('./db');
const axios = require('axios');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

const ODOO_URL = process.env.ODOO_URL || 'http://localhost:8069';
const ODOO_DB = process.env.DB_NAME || 'live';

// Izinkan CORS agar Vue 3 bisa terkoneksi ke Socket
const io = new Server(server, {
  cors: {
    origin: "*", // Pada produksi, batasi ke URL domain Vue 3 Anda
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Middleware Express untuk membaca raw body (Wajib untuk validasi HMAC yang akurat)
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

const PUSH_SECRET_KEY = process.env.PUSH_SECRET_KEY;

// ── MIDDLEWARE: VALIDASI HMAC DARI ODOO ──────────────────
function verifyOdooSignature(req, res, next) {
  const signature = req.headers['x-odoo-push-token'];
  const timestamp = req.headers['x-odoo-timestamp'];

  if (!signature || !timestamp) {
    return res.status(401).json({ error: 'Missing authentication headers' });
  }

  // Proteksi Replay Attack (Mencegah request lama dikirim ulang, batas aman 5 menit)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    return res.status(401).json({ error: 'Request timestamp expired' });
  }

  // Rekonstruksi tanda tangan HMAC-SHA256 sesuai format di Odoo push_bridge
  const expectedMessage = `${timestamp}.${req.rawBody}`;
  const computedSignature = crypto
    .createHmac('sha256', PUSH_SECRET_KEY)
    .update(expectedMessage)
    .digest('hex');

  if (signature !== computedSignature) {
    return res.status(403).json({ error: 'Invalid signature token' });
  }

  next();
}

// ── ENDPOINT REST API: MENERIMA PUSH DATA DARI ODOO ──────
app.post('/api/push', verifyOdooSignature, (req, res) => {
  const { eventType, data } = req.body;
  
  const requestId = crypto.randomUUID();
  
  // Kirim broadcast real-time ke semua client Vue 3 yang terhubung via Socket.io
  io.emit(`broadcast:${eventType}`, data);

  // Jika update bersifat spesifik per komponen grafik dinamis
  if (eventType === 'dashboard.dynamic_update' && data.item_id) {
    io.emit(`chart_refresh:${data.item_id}`, data);
  }

  // Odoo mengharapkan response HTTP 202 (Accepted) sesuai dengan kodenya
  return res.status(202).json({ status: 'success', requestId });
});


// ── SOCKET.IO EVENT HANDLERS (UNTUK FRONTEND VUE 3) ──────
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Event 1: Ambil daftar halaman dashboard (Headless CMS Router Helper)
  socket.on('get_dashboard_pages', async (data, callback) => {
    try {
      // Ambil userId yang dikirim oleh frontend (bisa bernilai null jika belum login)
      const userId = data ? data.userId : null;

      let queryText = '';
      let queryParams = [];

      if (userId) {
        // JIKA USER SUDAH LOGIN: Tampilkan semua halaman yang dipublikasikan (Public & Private)
        queryText = `
          SELECT id, name, slug, access_type, icon 
          FROM dashboard_engine_page 
          WHERE is_published = true
          ORDER BY sequence, id ASC
        `;
      } else {
        // JIKA BELUM LOGIN: Hanya tampilkan halaman yang bertipe 'public'
        queryText = `
          SELECT id, name, slug, access_type, icon 
          FROM dashboard_engine_page 
          WHERE is_published = true AND access_type = 'public'
          ORDER BY sequence, id ASC
        `;
      }

      const result = await db.query(queryText, queryParams);
      
      // Pastikan callback dipanggil sebagai fungsi yang aman
      if (typeof callback === 'function') {
        callback({ success: true, data: result.rows });
      }
    } catch (err) {
      console.error('Error fetching dashboard pages:', err);
      if (typeof callback === 'function') {
        callback({ success: false, error: 'Database error internal' });
      }
    }
  });

  // Event 2: Ambil detail halaman beserta daftar komponen grafik di dalamnya
  socket.on('get_dashboard_layout', async ({ slug, userId }, callback) => {
    try {
      if (!slug) {
        return callback({ success: false, error: 'Parameter URL Slug halaman wajib disertakan.' });
      }
      console.log(`[Layout Engine] User [UID: ${userId || 'PUBLIC'}] meminta layout halaman dengan slug: ${slug}`);

      // Ambil data halaman berdasarkan slug
      const pageQuery = `SELECT id, name, access_type, icon, is_published FROM dashboard_engine_page WHERE slug = $1 AND is_published = true LIMIT 1`;
      const pageRes = await db.query(pageQuery, [slug]);

      if (pageRes.rows.length === 0) {
        return callback({ success: false, error: 'Dashboard tidak ditemukan atau belum dipublish' });
      }

      const page = pageRes.rows[0];

      // Proteksi Akses Private Halaman
      if (page.access_type === 'private') {
        if (!userId) {
          console.warn(`[Security Alert] Akses ilegal ditolak untuk slug privat: ${slug}`);
          return callback({ success: false, error: 'Unauthorized: Halaman ini memerlukan login' });
        }
        
        // Cek apakah userId terdaftar di tabel relasi Many2many Odoo
        const accessQuery = `
          SELECT 1 FROM dashboard_page_user_rel 
          WHERE page_id = $1 AND user_id = $2
        `;
        const accessRes = await db.query(accessQuery, [page.id, userId]);
        if (accessRes.rows.length === 0) {
          return callback({ success: false, error: 'Forbidden: Anda tidak memiliki akses ke dashboard ini' });
        }
      }

      // Jika lolos sekuritas, ambil komponen item grafik di dalam halaman tersebut
      const itemsQuery = `
        SELECT id, name, chart_type, allow_toggle_view, query, has_goal, icon, direction, size 
        FROM dashboard_engine_item 
        WHERE page_id = $1 
        ORDER BY sequence, id
      `;
      const itemsRes = await db.query(itemsQuery, [page.id]);

      console.log(`[Layout Engine] Sukses memuat ${itemsRes.rows.length} komponen grafik untuk halaman [${page.name}]`);

      callback({ 
        success: true, 
        page_name: page.name,
        items: itemsRes.rows 
      });
    } catch (err) {
      console.error(`[Layout Engine Error] Gagal memuat susunan layout untuk slug ${slug}:`, err.message);
      callback({ success: false, error: 'Server error' });
    }
  });

  // Event 3: Eksekusi Kueri Utama Grafik (Dinonaktifkan jika data dipush langsung oleh Odoo)
  socket.on('get_chart_data', async ({ itemId, filters = {} }, callback) => {
    try {
      if (!itemId) {
        return callback({ success: false, error: 'Item ID wajib disertakan.' });
      }

      console.log(`[Data Engine] Menerima request data untuk Item ID: ${itemId}`);

      const itemQuery = `
        SELECT id, name, chart_type, query, has_goal, icon, direction, size 
        FROM dashboard_engine_item
        WHERE id = $1 LIMIT 1
      `;
      const itemRes = await db.query(itemQuery, [itemId]);
      
      if (itemRes.rows.length === 0) return callback({ success: false, error: 'Item not found' });

      // Jalankan kueri dinamis yang disimpan dari Odoo
      console.log(`[Data Engine] Mengeksekusi SQL untuk grafik [${itemRes.rows[0].name}]`);
      let query = itemRes.rows[0].query;
      const queryParams = [];
      let paramIndex = 1;

      for (const [key, value] of Object.entries(filters)) {
        const placeholder = `:${key}`;
        if (query.includes(placeholder)) {
          query = query.replaceAll(placeholder, `$${paramIndex}`);
          queryParams.push(value);
          paramIndex++;
        }
      }

      const dataRes = await db.query(query, queryParams);
      callback({ success: true, data: dataRes.rows, chart_type: itemRes.rows[0].chart_type });
    } catch (err) {
      console.error(`[Data Engine Error] Gagal memuat data grafik untuk ID ${itemId}:`, err.message);
      callback({ success: false, error: err.message });
    }
  });

  // Event 4: Eksekusi Kueri Detail Drawer Dinamis (Menangani Multi-Filter)
  socket.on('get_chart_detail_multi', async ({ itemId, filters }, callback) => {
    try {
      if (!itemId) {
        return callback({ success: false, error: 'Item ID wajib disertakan.' });
      }

      console.log(`[Drilldown Engine] Permintaan detail transaksi untuk Item ID: ${itemId}`);
      console.log(`[Drilldown Engine] Filter yang diterapkan:`, filters);

      const itemQuery = `SELECT id, name, query_detail FROM dashboard_engine_item WHERE id = $1 LIMIT 1`;
      const itemRes = await db.query(itemQuery, [itemId]);
      
      if (itemRes.rows.length === 0) {
        return callback({ success: false, error: 'Komponen grafik tidak ditemukan.' });
      }

      let sqlQuery = itemRes.rows[0].query_detail;
      if (!sqlQuery) {
        return callback({ success: false, error: 'Kueri detail (drilldown) belum dikonfigurasi di Odoo.' });
      }

      const queryParams = [];
      let paramIndex = 1;

      // Ubah :named_parameter (Odoo) menjadi $1, $2, dst (Postgres Node.js)
      for (const [key, value] of Object.entries(filters)) {
        const placeholder = `:${key}`;
        if (sqlQuery.includes(placeholder)) {
          sqlQuery = sqlQuery.replaceAll(placeholder, `$${paramIndex}`);
          queryParams.push(value);
          paramIndex++;
        }
      }
      const dataRes = await db.query(sqlQuery, queryParams);

      callback({ success: true, data: dataRes.rows });
    } catch (err) {
      console.error(`[Drilldown Error] Gagal memuat rincian untuk Item ID ${itemId}:`, err.message);
      callback({ success: false, error: err.message });
    }
  });

  // Event 5: Authentication Odoo
  socket.on('authenticate_user', async (data, callback) => {
    try {
      const { username, password } = data;

      // Validasi input awal di sisi server
      if (!username || !password) {
        return callback({ success: false, message: 'Username dan password wajib diisi.' });
      }

      // Susun payload standar protokol Odoo JSON-RPC 2.0
      const jsonRpcPayload = {
        jsonrpc: '2.0',
        method: 'call',
        params: {
          db: ODOO_DB,
          login: username,
          password: password
        },
        id: Math.floor(Math.random() * 1000)
      };

      console.log(`[Auth] Mencoba mengautentikasi user: ${username} ke DB Odoo: ${ODOO_DB}`);

      // Tembak langsung ke endpoint autentikasi native Odoo
      const odooResponse = await axios.post(`${ODOO_URL}/web/session/authenticate`, jsonRpcPayload, {
        headers: { 'Content-Type': 'application/json' }
      });

      // Periksa apakah ada error internal dari kembalian JSON-RPC Odoo
      if (odooResponse.data.error) {
        console.error('[Auth Error Odoo RPC]:', odooResponse.data.error.data.message);
        return callback({ 
          success: false, 
          message: odooResponse.data.error.data.message || 'Gagal tersambung dengan sistem ERP Odoo.' 
        });
      }

      const odooResult = odooResponse.data.result;

      // JIKA KREDENSIAL SALAH: Odoo akan mengembalikan uid bernilai false
      if (!odooResult || !odooResult.uid) {
        return callback({ success: false, message: 'Kombinasi username atau password Odoo salah.' });
      }

      // JIKA LOGIN SUKSES: Ekstrak profile data user dari sesi Odoo yang valid
      console.log(`[Auth Success] User ${username} berhasil masuk. UID Odoo: ${odooResult.uid}`);
      
      // Kita buat objek user minimalis dan token internal tiruan yang aman untuk frontend
      const cleanUserData = {
        id: odooResult.uid,
        name: odooResult.name,
        email: odooResult.username // Di Odoo, username biasanya berupa email
      };

      // Kembalikan sinyal sukses beserta data user ke Vue.js Frontend
      callback({
        success: true,
        token: `bridge_session_tok_${Math.random().toString(36).substring(2, 15)}`, // Token internal bridge
        user: cleanUserData
      });

    } catch (error) {
      console.error('[Bridge Internal Auth Error]:', error.message);
      callback({ 
        success: false, 
        message: 'Gagal menghubungi Server Bridge / Odoo sedang dalam pemeliharaan.' 
      });
    }
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Bridge Server running on port ${PORT}`);
});