# Odoo Real-time Bridge

Real-time bridge antara **Odoo 16** dan **frontend dashboard** menggunakan Node.js + Socket.io + PostgreSQL.

```
Odoo 16 ──HTTP POST──► Bridge ──Socket.io──► Frontend
  │                      │
  │                      └──Raw SQL──► Odoo PostgreSQL (bypass ORM)
  │
  └──ir.cron / model hook
```

---

## Struktur Project

```
odoo-bridge/
├── src/
│   ├── server.js                   # Entry point
│   ├── config/
│   │   ├── database.js             # Pool koneksi: bridge DB + Odoo DB
│   │   └── migrate.js              # Migrasi tabel bridge
│   ├── middleware/
│   │   ├── cors.js                 # CORS untuk Express + Socket.io
│   │   └── auth.js                 # HMAC (Odoo push) + JWT (frontend)
│   ├── services/
│   │   ├── socketService.js        # Socket.io rooms & broadcast
│   │   ├── cacheService.js         # Caching payload terakhir di PostgreSQL
│   │   └── odooQueryService.js     # Query langsung ke Odoo DB (bypass ORM)
│   ├── controllers/
│   │   ├── pushController.js       # POST /api/push dari Odoo
│   │   ├── dashboardController.js  # GET /api/dashboard/*
│   │   └── authController.js       # POST /api/auth/token
│   └── routes/
│       └── index.js                # Semua route + rate limiter
├── odoo_push_module/
│   └── bridge_push.py              # Modul Python untuk push dari Odoo 16
├── frontend-example/
│   └── bridge-client.js            # Contoh koneksi dari frontend
├── docker-compose.yml
├── Dockerfile
├── nginx.conf
└── .env.example
```

---

## Quick Start

### 1. Setup Environment

```bash
cp .env.example .env
# Edit .env sesuai konfigurasi lokal
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Jalankan Migrasi Database

```bash
# Buat database bridge terlebih dahulu:
createdb odoo_bridge

# Jalankan migrasi:
npm run migrate
```

### 4. Start Server

```bash
# Development
npm run dev

# Production
npm start
```

---

## Konfigurasi CORS

Edit `CORS_ORIGINS` di `.env`:

```env
CORS_ORIGINS=http://localhost:5173,https://dashboard.company.com
```

- Multiple origin dipisahkan koma
- Di development (NODE_ENV != production), jika tidak diset maka semua origin diizinkan
- Di production **wajib** diset atau semua cross-origin request ditolak

---

## Mekanisme Autentikasi

### Odoo → Bridge (HMAC-SHA256)

Setiap request dari Odoo harus menyertakan:

```
Header: X-Odoo-Push-Token: <hmac_hex>
Header: X-Odoo-Timestamp: <unix_timestamp>
```

HMAC dihitung sebagai:
```
HMAC-SHA256(PUSH_SECRET_KEY, "{timestamp}.{raw_body}")
```

Implementasi Python ada di `odoo_push_module/bridge_push.py`.

### Frontend → Bridge (JWT)

```bash
# 1. Ambil token
curl -X POST http://localhost:3000/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{"clientId": "dashboard-app", "clientSecret": "secret"}'

# 2. Gunakan token di socket.io
const socket = io('http://localhost:3000', {
  auth: { token: '<jwt_token>' }
})
```

Tambahkan CLIENT_CREDENTIALS di `.env`:
```env
CLIENT_CREDENTIALS=dashboard-app:secret:admin,readonly-app:secret2:viewer
```

---

## Bypass ORM Odoo untuk Data Besar

Untuk dataset besar, bridge mengakses PostgreSQL Odoo langsung menggunakan koneksi read-only:

```env
ODOO_PG_USER=kokai_readonly   # User dengan hak READ ONLY saja
ODOO_PG_PASSWORD=K0k41admin2020
```

### Buat user read-only di Odoo PostgreSQL:

```sql
-- Di psql sebagai superuser
CREATE ROLE kokai_readonly WITH LOGIN PASSWORD 'K0k41admin2020';
GRANT CONNECT ON DATABASE live TO kokai_readonly;
GRANT USAGE ON SCHEMA public TO kokai_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO kokai_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO kokai_readonly;
```

### Streaming untuk jutaan baris (cursor-based):

```js
// Di backend — tidak load semua data ke memory
await odooQueryStream(sql, params, async (batch, total) => {
  // Process 500 rows at a time
  socketService.broadcast('data.chunk', { batch, total });
}, 500);
```

---

## REST API Endpoints

| Method | Path | Auth | Deskripsi |
|--------|------|------|-----------|
| GET | /api/health | — | Health check |
| POST | /api/auth/token | — | Minta JWT token |
| GET | /api/auth/verify | JWT | Verifikasi token |
| POST | /api/push | HMAC | Push event dari Odoo |
| POST | /api/push/bulk | HMAC | Push multiple events |
| GET | /api/push/status | — | Status bridge |
| GET | /api/dashboard/kpi | JWT* | KPI aggregation |
| GET | /api/dashboard/sales | JWT* | Revenue chart data |
| GET | /api/dashboard/products | JWT* | Top products |
| GET | /api/dashboard/stock | JWT* | Stock levels |
| GET | /api/dashboard/ar-aging | JWT* | AR aging summary |
| GET | /api/dashboard/stream/sales | JWT* | SSE stream (big data) |

*JWT tidak wajib di development mode

---

## Socket.io Events

### Client → Server

| Event | Payload | Deskripsi |
|-------|---------|-----------|
| `subscribe` | `['sale.order', 'dashboard.kpi']` | Subscribe ke channel |
| `unsubscribe` | `['sale.order']` | Unsubscribe |
| `ping` | — | Health check |
| `request:latest` | `{ eventType }` | Minta data terakhir dari cache |

### Server → Client

| Event | Payload | Deskripsi |
|-------|---------|-----------|
| `bridge:connected` | `{ socketId, serverTime }` | Konfirmasi koneksi |
| `data:<eventType>` | `{ eventType, payload, serverTime }` | Data update |
| `bridge:refresh` | `{ reason }` | Sinyal refresh dashboard |

### Available Channels

```
all              - Semua events
sale.order       - Sales orders
account.move     - Invoice/Accounting
stock.move       - Inventory
mrp.production   - Manufacturing
dashboard.kpi    - KPI aggregation
dashboard.chart  - Chart data
hr.attendance    - HR attendance
purchase.order   - Purchase orders
```

---

## Setup Odoo Push (ir.cron)

Di Odoo 16, buat scheduled action untuk push periodik:

```python
# Technical > Automation > Scheduled Actions
# Code to execute:
env['bridge.push'].push_sales_kpi()
```

Atau push real-time dari model override (lihat `bridge_push.py`).

---

## Docker Deployment

```bash
# Copy env
cp .env.example .env
# Edit .env

# Build dan run
docker-compose up -d

# Lihat logs
docker-compose logs -f bridge
```

---

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| /api/push | 500 req/menit per IP |
| /api/dashboard/* | 200 req/menit per IP |
| /api/auth/token | 20 req/15 menit per IP |
