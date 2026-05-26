# odoo_push_module/bridge_push.py
"""
Odoo 16 Push Module — Bridge Integration
─────────────────────────────────────────────────────────
Install this as a utility module in your Odoo 16 instance.
It provides a service to push data to the Node.js bridge.

Add to ir.cron for scheduled pushes, or call from
model override methods (create/write/unlink) for real-time.
─────────────────────────────────────────────────────────
"""

import json
import hmac
import hashlib
import time
import logging
import requests
from datetime import datetime, timedelta

from odoo import models, fields, api
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

# ── Configuration (set in Odoo system parameters) ────────
BRIDGE_URL_PARAM   = 'bridge.url'           # e.g. http://bridge:3000
BRIDGE_SECRET_PARAM = 'bridge.push_secret'  # Must match PUSH_SECRET_KEY in .env
BRIDGE_ENABLED_PARAM = 'bridge.enabled'     # '1' to enable pushes


class BridgePushService(models.AbstractModel):
    """
    Abstract service model for pushing data to the Node.js bridge.
    Usage: self.env['bridge.push'].push_event('sale.order', data)
    """
    _name = 'bridge.push'
    _description = 'Real-time Bridge Push Service'

    # ── Core Push Method ──────────────────────────────────
    @api.model
    def push_event(self, event_type, data, source_model=None, record_ids=None, meta=None):
        """
        Push a single event to the bridge.
        :param event_type:   str   - e.g. 'sale.order', 'dashboard.kpi'
        :param data:         dict  - payload to broadcast
        :param source_model: str   - Odoo model name (for audit logging)
        :param record_ids:   list  - affected record IDs
        :param meta:         dict  - optional metadata (cacheTtl, etc.)
        """
        if not self._is_bridge_enabled():
            return False

        payload = {
            'eventType':   event_type,
            'data':        data,
            'sourceModel': source_model,
            'recordIds':   record_ids or [],
            'meta':        meta or {},
        }

        return self._do_push('/api/push', payload)

    @api.model
    def push_bulk(self, events):
        """
        Push multiple events in a single HTTP call (more efficient).

        :param events: list of dicts, each with keys:
                       eventType, data, sourceModel, recordIds, meta
        """
        if not self._is_bridge_enabled():
            return False

        return self._do_push('/api/push/bulk', {'events': events})

    # ── Odoo-Side Aggregation Helpers ─────────────────────
    @api.model
    def push_dynamic_dashboard_item(self, item_id):
        """
        Mengambil kueri dinamis dari dashboard.engine.item, 
        mengeksekusinya, dan mem-push hasilnya secara real-time ke Node.js.
        """
        # 1. Cari konfigurasi item dari modul custom_dashboard_engine
        item = self.env['dashboard.engine.item'].sudo().browse(item_id)
        if not item.exists():
            return False

        cr = self.env.cr
        try:
            # 2. Eksekusi main query yang ditulis di UI Odoo
            cr.execute(item.query)
            columns = [desc[0] for desc in cr.description]
            rows = [dict(zip(columns, row)) for row in cr.fetchall()]

            # 3. Kirim data hasil kueri ke Node.js secara dinamis
            # Node.js tidak perlu query lagi, tinggal terima bersih dan teruskan ke Vue 3!
            return self.push_event(
                event_type='dashboard.dynamic_update',
                data={
                    'item_id': item.id,
                    'chart_type': item.chart_type,
                    'allow_toggle_view': item.allow_toggle_view,
                    'chart_data': rows
                },
                source_model='dashboard.engine.item',
                record_ids=[item.id]
            )
        except Exception as e:
            _logger.error("Gagal push data dinamis untuk item %s: %s", item.name, str(e))
            return False

    # ── Internal Helpers ──────────────────────────────────
    def _is_bridge_enabled(self):
        param = self.env['ir.config_parameter'].sudo()
        return param.get_param(BRIDGE_ENABLED_PARAM, '0') == '1'

    def _get_bridge_config(self):
        param = self.env['ir.config_parameter'].sudo()
        url    = param.get_param(BRIDGE_URL_PARAM, '')
        secret = param.get_param(BRIDGE_SECRET_PARAM, '')
        if not url or not secret:
            raise UserError('Bridge URL and secret not configured in system parameters')
        return url.rstrip('/'), secret

    def _do_push(self, endpoint, payload):
        """Execute the HTTP push with HMAC authentication."""
        try:
            bridge_url, secret = self._get_bridge_config()
        except UserError as e:
            _logger.warning('Bridge push skipped: %s', e)
            return False

        body_bytes = json.dumps(payload, default=str).encode('utf-8')
        timestamp  = str(int(time.time()))

        # Compute HMAC-SHA256(secret, timestamp + '.' + body)
        signature = hmac.new(
            secret.encode('utf-8'),
            f"{timestamp}.{body_bytes.decode('utf-8')}".encode('utf-8'),
            hashlib.sha256,
        ).hexdigest()

        headers = {
            'Content-Type':       'application/json',
            'X-Odoo-Push-Token':  signature,
            'X-Odoo-Timestamp':   timestamp,
        }

        try:
            response = requests.post(
                f"{bridge_url}{endpoint}",
                data=body_bytes,
                headers=headers,
                timeout=5,  # Fast timeout — bridge should respond in <1s
            )

            if response.status_code == 202:
                _logger.debug(
                    'Bridge push accepted: %s → %s',
                    payload.get('eventType', endpoint),
                    response.json().get('requestId'),
                )
                return True
            else:
                _logger.warning(
                    'Bridge push failed: HTTP %s — %s',
                    response.status_code,
                    response.text[:200],
                )
                return False

        except requests.Timeout:
            _logger.warning('Bridge push timeout for %s', endpoint)
            return False
        except requests.ConnectionError as e:
            _logger.warning('Bridge push connection error: %s', e)
            return False
        except Exception as e:
            _logger.error('Bridge push unexpected error: %s', e)
            return False


# ── Example: Hook into sale.order create/write ────────────

class SaleOrderBridgeHook(models.Model):
    _inherit = 'sale.order'

    def write(self, vals):
        result = super().write(vals)
        # Push only on state-changing writes (confirmed, cancelled)
        trigger_fields = {'state', 'amount_total', 'invoice_status'}
        if trigger_fields.intersection(vals.keys()):
            item_id = 5 # ID dashboard.engine.item
            # Use after_commit to avoid pushing during transactions
            self.env.cr.postcommit.add(
                lambda: self.env['bridge.push'].push_dynamic_dashboard_item(item_id)
            )
        return result