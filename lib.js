/* Shared by the field app (index.html) and the admin dashboard (admin.html):
   Supabase client (login, database, photo storage), lead field mapping, CSV and ZIP helpers. */
(function (global) {
  'use strict';

  var cfg = global.IIJS_CONFIG || {};
  var BASE = String(cfg.supabaseUrl || '').trim().replace(/\/+$/, '');
  var KEY = String(cfg.supabaseKey || '').trim();
  var BUCKET = 'lead-photos';
  var enc = new TextEncoder();

  // ---------- lead fields: app name → database column ----------
  var FIELD_MAP = {
    name: 'firm_name', pocName: 'poc_name', phone: 'phone', city: 'city',
    profile: 'profile', profileDetail: 'profile_detail', stores: 'stores', storeCount: 'store_count',
    size: 'store_size', softwareType: 'software_type', softwareName: 'software_name',
    reason: 'reason', reasonDetail: 'reason_detail', product: 'products',
    action: 'next_action', actionDetail: 'next_action_detail', notes: 'notes', capturedBy: 'captured_by'
  };
  function toRow(lead, photoPaths) {
    var row = {
      id: lead.id, photos: photoPaths || [], deleted: !!lead.deleted,
      created_at: lead.timestamp, updated_at: lead.updatedAt || lead.timestamp
    };
    Object.keys(FIELD_MAP).forEach(function (k) { row[FIELD_MAP[k]] = String(lead[k] == null ? '' : lead[k]); });
    return row;
  }
  function fromRow(row) {
    var l = {
      id: row.id, userId: row.user_id, timestamp: row.created_at, updatedAt: row.updated_at,
      syncedAt: row.synced_at, deleted: !!row.deleted, photos: row.photos || []
    };
    Object.keys(FIELD_MAP).forEach(function (k) { l[k] = row[FIELD_MAP[k]] || ''; });
    return l;
  }

  // ---------- Supabase client (plain fetch, so it works offline-first and needs no library) ----------
  function apiError(message, status, code) {
    var e = new Error(message);
    e.status = status || 0;
    e.code = code || '';
    return e;
  }
  function readError(res) {
    return res.text().then(function (t) {
      var j = null;
      try { j = JSON.parse(t); } catch (e) { j = null; }
      var msg = (j && (j.error_description || j.msg || j.message || j.error)) || t || res.statusText || ('HTTP ' + res.status);
      throw apiError(String(msg), res.status, j && (j.error_code || j.code));
    });
  }

  function Api(scope) {
    this.storageKey = 'iijs_session_' + scope;
    this.session = null;
    this._refreshing = null;
    try { this.session = JSON.parse(localStorage.getItem(this.storageKey) || 'null'); } catch (e) { this.session = null; }
  }
  Api.configured = !!(BASE && KEY);
  Api.baseUrl = BASE;

  Api.prototype._save = function (s) {
    this.session = s;
    try {
      if (s) localStorage.setItem(this.storageKey, JSON.stringify(s));
      else localStorage.removeItem(this.storageKey);
    } catch (e) { /* storage blocked: session lasts for this tab only */ }
  };
  Api.prototype.userId = function () { return this.session && this.session.user ? this.session.user.id : ''; };
  Api.prototype.email = function () { return this.session && this.session.user ? this.session.user.email : ''; };

  Api.prototype._token = function (grant, body) {
    var self = this;
    return fetch(BASE + '/auth/v1/token?grant_type=' + grant, {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) return readError(res);
      return res.json();
    }).then(function (d) {
      var s = {
        access_token: d.access_token,
        refresh_token: d.refresh_token,
        expires_at: d.expires_at || Math.floor(Date.now() / 1000) + (d.expires_in || 3600),
        user: { id: d.user.id, email: d.user.email }
      };
      self._save(s);
      return s;
    });
  };
  Api.prototype.login = function (email, password) {
    return this._token('password', { email: email, password: password });
  };
  // Swap the refresh token for a fresh access token. A 4xx answer means the login is no
  // longer valid (expired, password changed, or deactivated by the admin).
  Api.prototype.refresh = function () {
    var self = this;
    if (!self.session) return Promise.reject(apiError('Not logged in', 401, 'no_session'));
    if (!self._refreshing) {
      self._refreshing = self._token('refresh_token', { refresh_token: self.session.refresh_token })
        .then(function (s) { self._refreshing = null; return s; }, function (e) {
          self._refreshing = null;
          if (e.status >= 400 && e.status < 500 && self.session) {
            self.session.expired = true;
            self._save(self.session);
            e.sessionExpired = true;
          }
          throw e;
        });
    }
    return self._refreshing;
  };
  Api.prototype.token = function () {
    var s = this.session;
    if (!s) return Promise.reject(apiError('Not logged in', 401, 'no_session'));
    if (s.expired) {
      var e = apiError('Your login has expired. Please log in again.', 401, 'session_expired');
      e.sessionExpired = true;
      return Promise.reject(e);
    }
    if (s.expires_at - 90 > Date.now() / 1000) return Promise.resolve(s.access_token);
    return this.refresh().then(function (n) { return n.access_token; });
  };
  Api.prototype.logout = function () {
    var s = this.session;
    this._save(null);
    if (s && !s.expired) {
      fetch(BASE + '/auth/v1/logout', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + s.access_token } })
        .catch(function () { /* offline: the token simply expires */ });
    }
  };
  Api.prototype.request = function (path, opts, retried) {
    var self = this;
    opts = opts || {};
    return self.token().then(function (tok) {
      var headers = Object.assign({ apikey: KEY, Authorization: 'Bearer ' + tok }, opts.headers || {});
      return fetch(BASE + path, { method: opts.method || 'GET', headers: headers, body: opts.body });
    }).then(function (res) {
      if (res.status === 401 && !retried) return self.refresh().then(function () { return self.request(path, opts, true); });
      if (!res.ok) return readError(res);
      return res;
    });
  };
  // Database (PostgREST): rest('GET', 'leads?select=*')
  Api.prototype.rest = function (method, path, body, prefer) {
    var headers = { 'Content-Type': 'application/json' };
    if (prefer) headers.Prefer = prefer;
    return this.request('/rest/v1/' + path, {
      method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (res) {
      return res.text().then(function (t) { return t ? JSON.parse(t) : null; });
    });
  };
  // Reads every row, page by page (the server returns at most 1000 rows per request).
  Api.prototype.selectAll = function (path) {
    var self = this, out = [], size = 1000;
    function page(from) {
      return self.request('/rest/v1/' + path, { headers: { 'Range-Unit': 'items', Range: from + '-' + (from + size - 1) } })
        .then(function (r) { return r.json(); })
        .then(function (rows) {
          out = out.concat(rows);
          return rows.length ? page(from + rows.length) : out;
        });
    }
    return page(0);
  };
  function encodePath(p) { return p.split('/').map(encodeURIComponent).join('/'); }
  Api.prototype.upload = function (path, blob) {
    return this.request('/storage/v1/object/' + BUCKET + '/' + encodePath(path), {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'image/jpeg', 'x-upsert': 'true', 'cache-control': 'max-age=3600' },
      body: blob
    });
  };
  // Temporary links to private photos: { path: url }
  Api.prototype.signUrls = function (paths, expiresIn) {
    if (!paths.length) return Promise.resolve({});
    return this.request('/storage/v1/object/sign/' + BUCKET, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: expiresIn || 3600, paths: paths })
    }).then(function (r) { return r.json(); }).then(function (list) {
      var map = {};
      (list || []).forEach(function (x) {
        var u = x.signedURL || x.signedUrl;
        if (u) map[x.path] = /^https?:/.test(u) ? u : BASE + '/storage/v1' + u;
      });
      return map;
    });
  };
  // Edge functions: fn('admin-users', { action: 'list' })
  Api.prototype.fn = function (name, body) {
    return this.request('/functions/v1/' + name, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  };

  // ---------- CSV ----------
  var COLS = [
    ['sr', 'Sr no.'], ['dateTime', 'Date & time'], ['name', 'Firm / visitor'], ['pocName', 'Owner / POC'], ['phone', 'Phone / WhatsApp'],
    ['city', 'City'], ['profile', 'Business profile'], ['profileDetail', 'Profile detail'], ['stores', 'Store setup'], ['storeCount', 'No. of stores'],
    ['size', 'Store size'], ['softwareType', 'Current software'], ['softwareName', 'Software name'], ['reason', 'Reason for visit'],
    ['reasonDetail', 'Reason detail'], ['product', 'Products pitched'], ['action', 'Next action'], ['actionDetail', 'Next action detail'],
    ['notes', 'Notes'], ['capturedBy', 'Captured by'], ['photoCount', 'Photos'], ['photoFiles', 'Photo files'],
    ['id', 'Lead ID'], ['timestamp', 'Created (ISO)'], ['updatedAt', 'Updated (ISO)']
  ];
  var HEADER_TO_KEY = {};
  COLS.forEach(function (c) { HEADER_TO_KEY[c[0].toLowerCase()] = c[0]; HEADER_TO_KEY[c[1].toLowerCase()] = c[0]; });

  function csvCell(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }
  function fmtDateTime(iso) {
    return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  // records: [{ sr, lead, files }]; extraCols: more [key, header] pairs read from the lead
  function buildCSV(records, extraCols) {
    var cols = COLS.concat(extraCols || []);
    var lines = [cols.map(function (c) { return csvCell(c[1]); }).join(',')];
    records.forEach(function (r) {
      var l = r.lead;
      var row = Object.assign({}, l, {
        sr: r.sr,
        dateTime: fmtDateTime(l.timestamp),
        photoCount: r.photoCount != null ? r.photoCount : (l.photoIds || l.photos || []).length,
        photoFiles: (r.files || []).map(function (f) { return f.replace(/^photos\//, ''); }).join(' | ')
      });
      lines.push(cols.map(function (c) { return csvCell(row[c[0]]); }).join(','));
    });
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  // ---------- ZIP (stored, no compression: photos are already JPEG) ----------
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function ZipWriter() {
    var d = new Date();
    this.time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    this.date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    this.parts = []; this.central = []; this.offset = 0; this.cdSize = 0; this.count = 0;
  }
  // u8: the file bytes (for the checksum); blobPart: optional Blob of the same bytes to avoid a copy
  ZipWriter.prototype.add = function (name, u8, blobPart) {
    if (typeof u8 === 'string') u8 = enc.encode(u8);
    var nm = enc.encode(name), crc = crc32(u8), size = u8.length;
    var h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, this.time, true); h.setUint16(12, this.date, true);
    h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true);
    h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
    this.parts.push(h.buffer, nm, blobPart || u8);
    var c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, this.time, true); c.setUint16(14, this.date, true);
    c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
    c.setUint16(28, nm.length, true);
    c.setUint32(42, this.offset, true);
    this.central.push(c.buffer, nm);
    this.cdSize += 46 + nm.length;
    this.offset += 30 + nm.length + size;
    this.count++;
  };
  ZipWriter.prototype.blob = function () {
    var e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true);
    e.setUint16(8, this.count, true); e.setUint16(10, this.count, true);
    e.setUint32(12, this.cdSize, true); e.setUint32(16, this.offset, true);
    return new Blob(this.parts.concat(this.central, [e.buffer]), { type: 'application/zip' });
  };

  // ---------- small helpers ----------
  function slug(s) { return (s || '').trim().replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'lead'; }
  function extFor(type) { return /png/.test(type) ? 'png' : /webp/.test(type) ? 'webp' : /hei[cf]/.test(type) ? 'heic' : 'jpg'; }

  global.IIJS = {
    Api: Api, FIELD_MAP: FIELD_MAP, toRow: toRow, fromRow: fromRow,
    COLS: COLS, HEADER_TO_KEY: HEADER_TO_KEY, csvCell: csvCell, buildCSV: buildCSV, fmtDateTime: fmtDateTime,
    ZipWriter: ZipWriter, slug: slug, extFor: extFor
  };
})(window);
