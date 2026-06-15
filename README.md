```python
import os

readme_content = """# Full-Stack Headless Odoo Dashboard Engine

Sebuah arsitektur dashboard analitik modern, aman, dan berkinerja tinggi berbasis data real-time dari **Odoo 16**. Proyek ini menggunakan Odoo murni sebagai **Headless CMS & Konfigurator Kueri**, sedangkan visualisasi data ditangani secara terpisah oleh server Node.js dan frontend Vue 3 untuk menjaga server utama Odoo tetap ringan.

## 🏗️ Tech Stack
* **Backend CMS:** Odoo 16 (Python) + PostgreSQL
* **Real-time Middleware Bridge:** Node.js + Express + Socket.io + `pg` (Connection Pooling)
* **Frontend (UI Dashboard):** Vue 3 (Composition API) + Pinia + Tailwind CSS + PrimeVue + ApexCharts

---

## 🗺️ Arsitektur Data & Sistem


```

```

[ Odoo 16 Web UI ] --(Menulis Raw SQL & Konfigurasi Halaman)--> [ PostgreSQL ]
│                                                             ▲
(Trigger Event)                                              (Read-Only Query)
│                                                             │
▼                                                             │
[ bridge_push.py ] --(HTTP POST + HMAC SHA256)--> [ Node.js Bridge Server ]
│
(Socket.io Broadcast)
│
▼
[ Vue 3 Frontend ]

```

---

## 📦 1. Backend: Custom Module Odoo (`custom_dashboard_engine`)

Modul ini berfungsi sebagai tempat mengatur halaman dashboard, tipe akses (*public/private*), manajemen user, serta mendefinisikan kueri SQL dinamis untuk grafik utama dan drawer detail (*drilldown*).

### Struktur Folder Modul
```text
custom_dashboard_engine/
├── __init__.py
├── __manifest__.py
├── models/
│   ├── __init__.py
│   ├── dashboard_page.py
│   └── dashboard_item.py
└── views/
    ├── dashboard_page_views.xml
    └── dashboard_item_views.xml

```

### Aturan Penulisan Kueri SQL di Odoo:

1. **Sumbu X Otomatis:** Kolom pertama yang di-`SELECT` pada *Main SQL Query* akan otomatis dijadikan kategori/sumbu X di ApexCharts.
2. **Multi-Series Stacked Chart:** Jika kueri mengembalikan lebih dari 2 kolom, kolom ke-2 akan dibaca sebagai nama kelompok (*series*) dan kolom ke-3 sebagai nilainya.
3. **Timezone UTC Odoo:** Karena Odoo menyimpan tipe data *datetime* dalam format UTC, gunakan konversi timezone pada kueri Anda agar sinkron dengan Waktu Indonesia Barat (WIB):
```sql
SELECT date(date_order AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Jakarta') as tanggal, ...

```


4. **Multi-Filter Detail Drawer:** Pada *Drawer Detail SQL Query*, gunakan token bernama seperti `:bulan` atau `:kategori` (sesuai alias kolom kueri utama) untuk filter dinamis saat grafik diklik:
```sql
SELECT name, price_total FROM sale_order_line WHERE to_char(date_order, 'YYYY-MM') = :bulan

```



---

## ⚡ 2. Real-time Push Utility (`bridge_push.py`)

Gunakan file ini sebagai utilitas di dalam instance Odoo Anda untuk memicu pembaruan data grafik secara instan (*event-driven*) ke Node.js setiap kali ada transaksi yang sukses di-commit (`postcommit`).

### Fitur Keamanan HMAC

Odoo mem-push data menggunakan otentikasi **HMAC-SHA256** untuk menjamin integritas data dan mencegah manipulasi request di tengah jalan (*Man-in-the-Middle*):

```python
signature = hmac.new(secret, f"{timestamp}.{body}", hashlib.sha256).hexdigest()

```

---

## 🎛️ 3. Middleware: Node.js Bridge Server

Node.js bertindak sebagai penengah yang menerima push data dari Odoo via REST API, melakukan validasi token HMAC, mengelola *connection pool* ke Postgres, serta menyuplai data ke Vue 3 melalui Socket.io.

### Struktur Folder Proyek

```text
dashboard-bridge/
├── .env
├── package.json
├── db.js
└── server.js

```

### Konfigurasi `.env`

```env
PORT=3000
PUSH_SECRET_KEY=rahasia_super_aman_anda_123

DB_USER=odoo
DB_PASSWORD=odoo_password
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=nama_database_odoo

```

### Instalasi & Menjalankan

```bash
cd dashboard-bridge
npm install
npm run dev

```

---

## 📺 4. Frontend: Vue 3 Dashboard

Aplikasi frontend mengambil konfigurasi layout secara dinamis berdasarkan `slug` URL dari Odoo, melakukan proteksi halaman berbasis user ID, menyediakan fitur *Toggle View* dari Grafik ke Tabel secara instan (*Zero Latency*), dan memproses *click-to-drilldown* multi-filter.

### Struktur Folder Komponen

```text
src/
├── store/
│   └── dashboard.js       # Pinia Store (Socket.io Client & State)
├── components/
│   └── DashboardItem.vue  # Universal Card Component (ApexCharts & PrimeVue Table)
└── views/
    └── DashboardView.vue  # Dynamic Grid Layout Manager

```

### Fitur Utama Frontend

* **Dynamic Responsive Grid Layout:** Menggunakan Grid Tailwind CSS yang otomatis menyesuaikan ukuran komponen. Tipe grafik melingkar (*Pie, Donut, RadialBar*) menggunakan `col-span-1`, sedangkan grafik tren/rentang (*Line, Bar, Area*) melebar otomatis menggunakan `lg:col-span-3`.
* **Dynamic View Toggle:** Pengguna dapat mengubah visualisasi grafik menjadi tabel data tabular secara instan tanpa perlu membebani database dengan kueri ulang.
* **Reactive Re-rendering:** Komponen mendengarkan channel socket `chart_refresh:${item.id}`. Begitu ada push data dari Odoo, grafik akan bergerak memperbarui nilainya secara real-time dengan animasi halus bawaan ApexCharts tanpa *reload* halaman browser.

---

## 🔒 Fitur Keamanan Sistem (Antipeluru)

1. **SQL Injection Protection:** Node.js mem-parsing parameter filter dari Vue 3 menggunakan *Parameterized Queries / Prepared Statements* (`$1`, `$2`), bukan teknik *string concatenation*.
2. **Odoo Injection Blacklist:** Fungsi Python `action_verify_queries` memblokir perintah modifikasi data (`DROP`, `DELETE`, `TRUNCATE`, `UPDATE`, `INSERT`) sebelum kueri disimpan di form view Odoo.
3. **Private Page Restriction:** Node.js melakukan pengecekan silang (*cross-check*) ke tabel relasi `dashboard_page_user_rel` di PostgreSQL untuk memastikan hanya user terdaftar yang bisa melihat dashboard bertipe *Private*.

## 🚀 Langkah Memulai Pengembangan

1. Salin folder `custom_dashboard_engine` ke direktori *addons* Odoo Anda, lalu install modulnya.
2. Buka menu **Vue Dashboard** di Odoo, buat halaman baru, isi `slug` (misal: `sales-performance`), tentukan jenis akses, dan tulis kueri SQL grafik Anda. Klik tombol **Verify SQL Query** untuk memastikan kueri Anda bebas error.
3. Konfigurasikan Parameter Sistem Odoo (`bridge.url`, `bridge.push_secret`, `bridge.enabled`).
4. Jalankan server **Node.js Bridge**.
5. Buka frontend **Vue 3** Anda ke rute URL sesuai slug halaman yang Anda buat: `http://localhost:5173/page/sales-performance`.
"""