/* =========================================================
   BizStore PH — app.js
   POS, Inventory, Setup & Financials
   Data layer: Supabase (kapag may config) o localStorage (fallback)
   ========================================================= */
'use strict';

/* ---------------------------------------------------------
   HELPERS
--------------------------------------------------------- */
const CFG = window.BIZSTORE_CONFIG || {};
const DEFAULT_CATEGORIES = ['Skincare', 'Cosmetics', 'Apparel', 'General'];
const SOLD_ACTION = 'Sold (Checkout)';
const EMPTY_SETUP = () => ({ rent: 0, targetProfitPercent: 30, employees: [], subscriptions: [], utilities: [], packaging: [], marketing: [], permitsMisc: [], supplies: [] });

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ym = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const thisMonthKey = () => ym(new Date());
const $ = (id) => document.getElementById(id);
const num = (v) => parseFloat(v) || 0;
const peso = (n) => '₱' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sum = (arr, key) => (arr || []).reduce((s, x) => s + (Number(key ? x[key] : x) || 0), 0);

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** Safe string literal para sa inline onclick="fn(...)" */
const jsArg = (s) => esc(JSON.stringify(String(s ?? '')));

function revenueOf(log) {
    if (log.revenue !== undefined && log.revenue !== null) return Number(log.revenue) || 0;
    const m = String(log.note || '').match(/₱([\d,]+\.?\d*)/);
    return m ? parseFloat(m[1].replace(/,/g, '')) || 0 : 0;
}

function normalizeSetup(s) {
    const base = EMPTY_SETUP();
    if (!s || typeof s !== 'object') return base;
    const out = { ...base, ...s };
    ['employees', 'subscriptions', 'utilities', 'packaging', 'marketing', 'permitsMisc', 'supplies'].forEach((k) => {
        if (!Array.isArray(out[k])) out[k] = [];
    });
    out.rent = num(out.rent);
    out.targetProfitPercent = out.targetProfitPercent === undefined || out.targetProfitPercent === null ? 30 : num(out.targetProfitPercent);
    return out;
}

function monthlyTotals(cfg) {
    const c = normalizeSetup(cfg);
    const fixed = c.rent + sum(c.employees, 'salary') + sum(c.subscriptions, 'cost');
    const variable = sum(c.utilities, 'cost') + sum(c.packaging, 'cost') + sum(c.marketing, 'cost') + sum(c.permitsMisc, 'cost') + sum(c.supplies, 'cost');
    return { fixed, variable, total: fixed + variable };
}

function setButtonBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) {
        btn.dataset.label = btn.innerText;
        btn.disabled = true;
        btn.innerText = label || 'Please wait...';
        btn.classList.add('opacity-60', 'cursor-wait');
    } else {
        btn.disabled = false;
        btn.innerText = label || btn.dataset.label || btn.innerText;
        btn.classList.remove('opacity-60', 'cursor-wait');
    }
}

/* ---------------------------------------------------------
   DATA LAYER — localStorage
--------------------------------------------------------- */
const LS = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
    set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
    del(k) { localStorage.removeItem(k); }
};
const localId = () => 'id_' + Math.random().toString(36).slice(2, 11);

const localDb = {
    mode: 'local',
    async init() {},

    async getCategories() { return LS.get('bizCategories', [...DEFAULT_CATEGORIES]); },
    async addCategory(name) { const c = await this.getCategories(); c.push(name); LS.set('bizCategories', c); },
    async removeCategory(name) { LS.set('bizCategories', (await this.getCategories()).filter((c) => c !== name)); },

    async getInventory() { return LS.get('bizstore_inventory', []); },
    async barcodeExists(barcode, excludeId) {
        return (await this.getInventory()).some((p) => p.barcode === barcode && p.id !== excludeId);
    },
    async saveProduct(product, id) {
        const inv = await this.getInventory();
        if (id) {
            const idx = inv.findIndex((x) => x.id === id);
            if (idx < 0) throw new Error('Product not found');
            inv[idx] = { ...inv[idx], ...product, id };
            LS.set('bizstore_inventory', inv);
            return inv[idx];
        }
        const saved = { ...product, id: localId(), timestamp: Date.now() };
        inv.push(saved);
        LS.set('bizstore_inventory', inv);
        return saved;
    },
    async deleteProduct(id) { LS.set('bizstore_inventory', (await this.getInventory()).filter((x) => x.id !== id)); },

    async addLog(log) {
        const logs = LS.get('bizstore_logs', []);
        logs.push({ ...log, timestamp: Date.now() });
        LS.set('bizstore_logs', logs);
    },
    async getLogs(productId) {
        return LS.get('bizstore_logs', []).filter((l) => l.productId === productId).sort((a, b) => b.timestamp - a.timestamp);
    },
    async getFinancialLogs(from, to) {
        const f = from.getTime(), t = to.getTime();
        return LS.get('bizstore_logs', [])
            .filter((l) => (l.action === SOLD_ACTION || l.action.includes('(In)')) && l.timestamp >= f && l.timestamp < t)
            .map((l) => ({ timestamp: l.timestamp, action: l.action, revenue: revenueOf(l) || 0, qtyChange: l.qtyChange || 0, productId: l.productId }));
    },

    async getSetup(month) {
        return LS.get('bizConfig_v6_' + month, null) || LS.get('bizConfig_v5', null);
    },
    async saveSetup(month, data) { LS.set('bizConfig_v6_' + month, data); },
    async deleteSetup(month) { LS.del('bizConfig_v6_' + month); },

    async checkout(items, cust, type, paid) {
        const inv = await this.getInventory();
        for (const it of items) {
            const p = inv.find((x) => x.id === it.id);
            if (!p) throw new Error(`${it.name} not found`);
            if (it.qty > p.qty) throw new Error(`Kulang ang stock ng ${p.name}: ${p.qty} na lang`);
        }
        for (const it of items) {
            const p = inv.find((x) => x.id === it.id);
            p.qty -= it.qty;
            await this.addLog({ productId: it.id, productName: p.name, action: SOLD_ACTION, qtyChange: -it.qty, revenue: (it.price || 0) * it.qty, note: `Total Revenue: ${peso((it.price || 0) * it.qty)}` });
        }
        LS.set('bizstore_inventory', inv);
    },

    async uploadImage(dataUrl) { return dataUrl; },
    
    async getOrders() { return []; },
    async releaseOrder() {},
    async cancelOrder() {}
};

/* ---------------------------------------------------------
   DATA LAYER — Supabase
--------------------------------------------------------- */
function isSupabaseConfigured() {
    return !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY &&
        !CFG.SUPABASE_URL.includes('YOUR_PROJECT_REF') && !CFG.SUPABASE_ANON_KEY.includes('YOUR_') &&
        window.supabase && typeof window.supabase.createClient === 'function');
}

function check({ data, error }) {
    if (error) {
        console.error('Supabase Error:', error);
        throw new Error(error.message || 'Database error');
    }
    return data;
}

const rowToProduct = (r) => ({
    id: r.id, name: r.name, category: r.category, barcode: r.barcode,
    cost: Number(r.cost) || 0, qty: r.qty || 0,
    sellingPrice: Number(r.selling_price) || null,
    dateIn: r.date_in || '', expiryDate: r.expiry_date || '',
    image: r.image_url || '', timestamp: new Date(r.created_at).getTime()
});
const productToRow = (p) => ({
    name: p.name, category: p.category, barcode: p.barcode, cost: p.cost, qty: p.qty,
    selling_price: p.sellingPrice || null,
    date_in: p.dateIn || null, expiry_date: p.expiryDate || null, image_url: p.image || null
});

function createSupabaseDb() {
    const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
    const bucket = CFG.IMAGE_BUCKET || 'product-images';

    async function fetchAll(build) {
        const size = 1000; let from = 0; const out = [];
        while (true) {
            const rows = check(await build().range(from, from + size - 1));
            out.push(...rows);
            if (rows.length < size) return out;
            from += size;
        }
    }

    return {
        mode: 'supabase',
        client: sb,

        async init() {
            const { error } = await sb.from('categories').select('id').limit(1);
            if (error) throw new Error('Supabase: ' + error.message + ' — na-run mo na ba ang supabase/schema.sql?');
        },

        async getCategories() {
            const rows = check(await sb.from('categories').select('name').order('created_at'));
            return rows.length ? rows.map((r) => r.name) : [...DEFAULT_CATEGORIES];
        },
        async addCategory(name) { check(await sb.from('categories').insert({ name })); },
        async removeCategory(name) { check(await sb.from('categories').delete().eq('name', name)); },

        async getInventory() {
            const rows = await fetchAll(() => sb.from('products').select('*').order('created_at', { ascending: false }));
            return rows.map(rowToProduct);
        },
        async barcodeExists(barcode, excludeId) {
            let q = sb.from('products').select('id').eq('barcode', barcode);
            if (excludeId) q = q.neq('id', excludeId);
            return check(await q.limit(1)).length > 0;
        },
        async saveProduct(product, id) {
            const row = productToRow(product);
            if (id) {
                return rowToProduct(check(await sb.from('products').update({ ...row, updated_at: new Date().toISOString() }).eq('id', id).select().single()));
            }
            return rowToProduct(check(await sb.from('products').insert(row).select().single()));
        },
        async deleteProduct(id) { check(await sb.from('products').delete().eq('id', id)); },

        async addLog(log) {
            check(await sb.from('stock_logs').insert({
                product_id: log.productId || null, product_name: log.productName || null,
                action: log.action, qty_change: log.qtyChange || 0, revenue: log.revenue || 0, note: log.note || null
            }));
        },
        async getLogs(productId) {
            const rows = check(await sb.from('stock_logs').select('*').eq('product_id', productId).order('created_at', { ascending: false }).limit(500));
            return rows.map((r) => ({ action: r.action, qtyChange: r.qty_change, revenue: Number(r.revenue), note: r.note, timestamp: new Date(r.created_at).getTime() }));
        },
        async getFinancialLogs(from, to) {
            const rows = await fetchAll(() => sb.from('stock_logs').select('created_at, action, revenue, qty_change, product_id')
                .in('action', [SOLD_ACTION, 'Initial Stock In', 'Stock Adjustment (In)'])
                .gte('created_at', from.toISOString()).lt('created_at', to.toISOString()).order('created_at'));
            return rows.map((r) => ({ timestamp: new Date(r.created_at).getTime(), action: r.action, revenue: Number(r.revenue) || 0, qtyChange: r.qty_change, productId: r.product_id }));
        },

        async getSetup(month) {
            // Kunin ang config ng buwan; kung wala, gamitin ang pinakahuling naunang buwan
            const rows = check(await sb.from('setup_configs').select('data').lte('month', month).order('month', { ascending: false }).limit(1));
            return rows.length ? rows[0].data : null;
        },
        async saveSetup(month, data) {
            check(await sb.from('setup_configs').upsert({ month, data, updated_at: new Date().toISOString() }));
        },
        async deleteSetup(month) { check(await sb.from('setup_configs').delete().eq('month', month)); },

        async checkout(items, cust, type, paid) {
            check(await sb.rpc('create_order', { 
                p_customer: cust || null, 
                p_type: type, 
                p_paid: paid, 
                p_note: '', 
                p_items: items 
            }));
        },

        async getOrders(statusFilter) {
            let q = sb.from('orders').select('*').order('created_at', { ascending: false });
            if (statusFilter === 'Pending') q = q.in('status', ['pending']).or('payment_status.eq.unpaid');
            else if (statusFilter === 'Completed') q = q.eq('status', 'released').eq('payment_status', 'paid');
            else if (statusFilter === 'Cancelled') q = q.eq('status', 'cancelled');
            return check(await q.limit(200));
        },
        async releaseOrder(id) { check(await sb.rpc('release_order', { p_order_id: id })); },
        async cancelOrder(id) { check(await sb.rpc('cancel_order', { p_order_id: id })); },

        async uploadImage(dataUrl) {
            if (!dataUrl || !dataUrl.startsWith('data:')) return dataUrl || '';
            const blob = await (await fetch(dataUrl)).blob();
            const ext = blob.type === 'image/png' ? 'png' : 'jpg';
            const path = `products/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
            check(await sb.storage.from(bucket).upload(path, blob, { contentType: blob.type, upsert: false }));
            return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
        }
    };
}

/* ---------------------------------------------------------
   STATE
--------------------------------------------------------- */
let db = localDb;
let categories = [...DEFAULT_CATEGORIES];
let allProductsCache = [];
let cart = [];
let currentPosCategory = 'All';
let currentInventoryCategory = 'All';
let setupData = EMPTY_SETUP();      // ine-edit sa Setup tab
let savedMonthConfig = null;        // naka-save na config (ginagamit sa pricing)
let html5QrCode = null;
let snapshotStream = null;
let capturedImageData = '';
let editingImage = '';
let financialChartInstance = null;
let financialReqId = 0;

/* ---------------------------------------------------------
   UI BASICS
--------------------------------------------------------- */
function showToast(message, isError = false) {
    const toast = $('toastNotif');
    const icon = $('toastIcon');
    $('toastMessage').innerText = message;
    toast.classList.toggle('toast-error', !!isError);
    icon.innerText = isError ? '!' : '✓';
    toast.classList.remove('translate-x-full', 'opacity-0');
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => toast.classList.add('translate-x-full', 'opacity-0'), 3200);
}

function setDbStatus() {
    const el = $('dbStatus');
    if (!el) return;
    if (db.mode === 'supabase') {
        el.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-[#1F9D55]"></span> Supabase';
        el.className = 'hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold bg-[#E3F6EA] text-[#1F9D55] border border-[#BFE8CF]';
        el.title = 'Connected to Supabase cloud database';
    } else {
        el.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-[#FFB800]"></span> Offline';
        el.className = 'hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold bg-[#FFF4D6] text-[#9A6B00] border border-[#FFE3A0]';
        el.title = 'Local storage mode — ilagay ang Supabase keys sa config.js';
    }
}

const NAV_INACTIVE = 'px-4 py-1.5 rounded-full text-xs font-medium text-[#6B5470] hover:bg-[#FBF1F7] transition';
const NAV_ACTIVE = 'px-4 py-1.5 rounded-full text-xs font-medium bg-[#C81E5C] text-white shadow-sm transition';

function switchTab(tabId) {
    ['pos', 'input', 'inventory', 'setup', 'orders', 'schedule'].forEach((t) => {
        if ($(`tab-${t}`)) $(`tab-${t}`).classList.add('hidden');
        if ($(`nav-${t}`)) $(`nav-${t}`).className = NAV_INACTIVE;
    });
    if ($(`tab-${tabId}`)) $(`tab-${tabId}`).classList.remove('hidden');
    if ($(`nav-${tabId}`)) $(`nav-${tabId}`).className = NAV_ACTIVE;

    if (tabId !== 'input') { stopScanner(); stopSnapshotCamera(); }
    if (tabId === 'pos') loadPosCatalog();
    if (tabId === 'inventory') loadInventory();
    if (tabId === 'setup') loadSetupConfigToUi();
    if (tabId === 'orders' && typeof loadOrders === 'function') loadOrders();
    if (tabId === 'schedule' && typeof loadSchedule === 'function') loadSchedule();
}

/* ---------------------------------------------------------
   CATEGORIES
--------------------------------------------------------- */
function loadCategoryDropdowns() {
    const select = $('prodCategory');
    const prev = select.value;
    select.innerHTML = categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    if (categories.includes(prev)) select.value = prev;

    const chip = (active) => `px-3 py-1 rounded-full ${active ? 'bg-[#C81E5C] text-white' : 'bg-white border border-[#F2DCE8] text-[#6B5470] hover:bg-[#FBF1F7]'} font-medium shrink-0 text-[10px] transition`;
    const renderFilters = (containerId, currentCat, fn) => {
        $(containerId).innerHTML = ['All', ...categories]
            .map((c) => `<button onclick="${fn}(${jsArg(c)})" class="${chip(currentCat === c)}">${esc(c)}</button>`).join('');
    };
    renderFilters('posCategoryFilters', currentPosCategory, 'filterPosByCategory');
    renderFilters('inventoryCategoryFilters', currentInventoryCategory, 'filterInventoryByCategory');
}

function renderCategoryModalList() {
    $('categoryListUi').innerHTML = categories.map((cat) => `
        <li class="flex justify-between items-center bg-[#FFF9F2] p-2 rounded border border-[#F2DCE8]">
            <span>${esc(cat)}</span>
            <button onclick="removeCategory(${jsArg(cat)})" class="text-[#DC2626] hover:scale-110 transition">✕</button>
        </li>`).join('');
}

function openCategoryModal() {
    renderCategoryModalList();
    $('categoryModal').classList.remove('hidden');
    setTimeout(() => $('newCategoryInput').focus(), 50);
}
function closeCategoryModal() { $('categoryModal').classList.add('hidden'); loadCategoryDropdowns(); }

async function addCategory() {
    const input = $('newCategoryInput');
    const val = input.value.trim();
    if (!val) return;
    if (categories.some((c) => c.toLowerCase() === val.toLowerCase())) { showToast('Category already exists.', true); return; }
    try {
        await db.addCategory(val);
        categories.push(val);
        input.value = '';
        renderCategoryModalList();
        loadCategoryDropdowns();
        showToast(`Category "${val}" added.`);
    } catch (err) { showToast('Error: ' + err.message, true); }
}

async function removeCategory(name) {
    if (categories.length <= 1) { showToast('Keep at least one category.', true); return; }
    try {
        await db.removeCategory(name);
        categories = categories.filter((c) => c !== name);
        if (currentPosCategory === name) currentPosCategory = 'All';
        if (currentInventoryCategory === name) currentInventoryCategory = 'All';
        renderCategoryModalList();
        loadCategoryDropdowns();
    } catch (err) { showToast('Error: ' + err.message, true); }
}

/* ---------------------------------------------------------
   PRICING
--------------------------------------------------------- */
function getPrice(p, totalStock) {
    if (p.sellingPrice && p.sellingPrice > 0) return p.sellingPrice;
    const cfg = normalizeSetup(savedMonthConfig || setupData);
    const overheadPerUnit = monthlyTotals(cfg).total / (totalStock > 0 ? totalStock : 1);
    return (Number(p.cost) + overheadPerUnit) * (1 + cfg.targetProfitPercent / 100);
}
const totalStockOf = (list) => (list || allProductsCache).reduce((s, p) => s + (p.qty || 0), 0);

/* ---------------------------------------------------------
   SETUP & FINANCIAL MONITOR
--------------------------------------------------------- */
function toggleFinancialViewMode() {
    const mode = $('financialViewMode').value;
    const container = $('financialTimePickerContainer');
    const now = new Date();
    const cls = 'px-2.5 py-1 border border-[#F2DCE8] rounded-lg bg-white font-medium text-xs outline-none';

    if (mode === 'daily') {
        container.innerHTML = `<input type="date" id="financialDateSelect" value="${ymd(now)}" onchange="loadFinancials()" class="${cls}">`;
    } else if (mode === 'monthly') {
        container.innerHTML = `<input type="month" id="financialMonthSelect" value="${ym(now)}" onchange="loadFinancials()" class="${cls}">`;
    } else {
        const y0 = now.getFullYear();
        let opts = '';
        for (let y = y0; y >= y0 - 3; y--) opts += `<option value="${y}" ${y === y0 ? 'selected' : ''}>${y}</option>`;
        container.innerHTML = `<select id="financialYearSelect" onchange="loadFinancials()" class="${cls}">${opts}</select>`;
    }
    loadFinancials();
}

async function loadSetupConfigToUi() {
    try {
        savedMonthConfig = await db.getSetup(thisMonthKey());
    } catch (err) {
        showToast('Hindi ma-load ang setup: ' + err.message, true);
    }
    setupData = normalizeSetup(savedMonthConfig ? JSON.parse(JSON.stringify(savedMonthConfig)) : null);

    $('setupRent').value = setupData.rent || 0;
    $('setupTargetProfitPercent').value = setupData.targetProfitPercent;
    renderEmployeesTable();
    ['subscriptions', 'utilities', 'packaging', 'marketing', 'permitsMisc', 'supplies'].forEach((k) => renderDynamicList(k, setupData[k]));
    calculateTotalExpenses();

    if (!$('financialTimePickerContainer').innerHTML.trim()) toggleFinancialViewMode();
    else loadFinancials();
}

function getFinancialRange() {
    const mode = $('financialViewMode').value;
    const now = new Date();
    if (mode === 'daily') {
        const key = ($('financialDateSelect') || {}).value || ymd(now);
        const end = new Date(key + 'T00:00:00'); end.setDate(end.getDate() + 1);
        const start = new Date(end); start.setDate(start.getDate() - 7);
        return { mode, key, start, end };
    }
    if (mode === 'monthly') {
        const key = ($('financialMonthSelect') || {}).value || ym(now);
        const [y, m] = key.split('-').map(Number);
        return { mode, key, start: new Date(y, m - 1, 1), end: new Date(y, m, 1) };
    }
    const key = ($('financialYearSelect') || {}).value || String(now.getFullYear());
    const y = parseInt(key, 10);
    return { mode, key, start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1) };
}

async function loadFinancials() {
    calculateTotalExpenses();
    const reqId = ++financialReqId;
    const { mode, key, start, end } = getFinancialRange();

    let logs = [];
    try {
        logs = await db.getFinancialLogs(start, end);
    } catch (err) {
        showToast('Hindi ma-load ang logs: ' + err.message, true);
    }
    if (reqId !== financialReqId) return;

    const monthlyExpense = monthlyTotals(setupData).total;
    const labels = [], revenues = [], expenses = [];
    let totalRevenue = 0, totalExpenses = 0;

    const getPurchaseCost = (l) => {
        if (!l.action.includes('(In)')) return 0;
        const p = allProductsCache.find((x) => x.id === l.productId);
        return (l.qtyChange > 0 ? l.qtyChange : 0) * (p ? Number(p.cost) : 0);
    };

    if (mode === 'daily') {
        const revBuckets = {};
        const expBuckets = {};
        logs.forEach((l) => { 
            const k = ymd(new Date(l.timestamp)); 
            if (l.action === SOLD_ACTION) revBuckets[k] = (revBuckets[k] || 0) + l.revenue;
            else expBuckets[k] = (expBuckets[k] || 0) + getPurchaseCost(l);
        });
        for (let i = 0; i < 7; i++) {
            const d = new Date(start); d.setDate(start.getDate() + i);
            const k = ymd(d);
            labels.push(k.slice(5));
            revenues.push(revBuckets[k] || 0);
            expenses.push((monthlyExpense / 30) + (expBuckets[k] || 0));
        }
        totalRevenue = revBuckets[key] || 0;
        totalExpenses = (monthlyExpense / 30) + (expBuckets[key] || 0);
    } else if (mode === 'monthly') {
        const [y, m] = key.split('-').map(Number);
        const days = new Date(y, m, 0).getDate();
        const revBuckets = new Array(days).fill(0);
        const expBuckets = new Array(days).fill(0);
        logs.forEach((l) => {
            const idx = new Date(l.timestamp).getDate() - 1;
            if (l.action === SOLD_ACTION) revBuckets[idx] += l.revenue;
            else expBuckets[idx] += getPurchaseCost(l);
        });
        for (let d = 1; d <= days; d++) {
            labels.push(String(d));
            revenues.push(revBuckets[d - 1]);
            expenses.push((monthlyExpense / days) + expBuckets[d - 1]);
        }
        totalRevenue = sum(revBuckets);
        totalExpenses = monthlyExpense + sum(expBuckets);
    } else {
        const revBuckets = new Array(12).fill(0);
        const expBuckets = new Array(12).fill(0);
        logs.forEach((l) => { 
            const idx = new Date(l.timestamp).getMonth();
            if (l.action === SOLD_ACTION) revBuckets[idx] += l.revenue;
            else expBuckets[idx] += getPurchaseCost(l);
        });
        labels.push('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec');
        revenues.push(...revBuckets);
        expenses.push(...expBuckets.map(e => monthlyExpense + e));
        totalRevenue = sum(revBuckets);
        totalExpenses = (monthlyExpense * 12) + sum(expBuckets);
    }

    const netProfit = totalRevenue - totalExpenses;
    const margin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

    $('metricRevenue').innerText = peso(totalRevenue);
    $('metricExpenses').innerText = peso(totalExpenses);
    const profitEl = $('metricNetProfit');
    profitEl.innerText = peso(netProfit);
    profitEl.className = `text-base font-bold ${netProfit >= 0 ? 'text-[#1F9D55]' : 'text-[#DC2626]'}`;
    $('metricMargin').innerText = `${margin.toFixed(1)}%`;

    const advice = $('financialAdvice');
    if (totalRevenue === 0 && totalExpenses === 0) {
        advice.innerText = 'Tip: Mag-checkout ng items at i-save ang expenses para makita ang performance.';
        advice.className = 'text-[10px] text-[#8A7690] italic';
    } else if (netProfit < 0) {
        advice.innerText = '⚠️ Lugi sa napiling panahon! Subukang taasan ang Target Markup Profit % o bawasan ang overhead.';
        advice.className = 'text-[10px] text-[#DC2626] font-semibold italic';
    } else {
        advice.innerText = '✨ Maganda ang performance! Kumikita ka sa panahong ito. Ipagpatuloy ang pagsubaybay.';
        advice.className = 'text-[10px] text-[#1F9D55] font-semibold italic';
    }

    renderFinancialChart(labels, revenues, expenses);
}

function renderFinancialChart(labels, revenues, expenses) {
    if (typeof Chart === 'undefined') return;
    const ctx = $('financialChart').getContext('2d');
    if (financialChartInstance) financialChartInstance.destroy();
    financialChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'Revenue (₱)', data: revenues, borderColor: '#1F9D55', backgroundColor: 'rgba(31,157,85,0.1)', fill: true, tension: 0.3, pointRadius: 2 },
                { label: 'Expenses (₱)', data: expenses, borderColor: '#DC2626', backgroundColor: 'rgba(220,38,38,0.05)', fill: true, tension: 0.3, pointRadius: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'top', labels: { boxWidth: 12, font: { size: 10 } } },
                tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${peso(c.parsed.y)}` } }
            },
            scales: { y: { beginAtZero: true, ticks: { font: { size: 9 } } }, x: { ticks: { font: { size: 9 } } } }
        }
    });
}

function renderDynamicList(key, items) {
    const container = $(`${key}List`);
    if (!items || items.length === 0) {
        container.innerHTML = `<p class="text-[10px] text-[#B7A7BE]">No items.</p>`;
        return;
    }
    
    let productOptions = '';
    if (key === 'supplies') {
        productOptions = allProductsCache.map(p => `<option value="${p.id}">${esc(p.name)} (₱${p.cost})</option>`).join('');
    }

    container.innerHTML = items.map((item, i) => {
        if (key === 'supplies') {
            return `
            <div class="flex flex-col gap-1 bg-white p-1.5 rounded-lg border border-[#F2DCE8] mb-1.5">
                <div class="flex gap-1.5 items-center">
                    <select onchange="handleSupplySelect(this, ${i})" class="flex-grow px-2 py-1 text-[10px] outline-none border border-[#F2DCE8] rounded bg-[#FFF9F2] text-[#6B5470]">
                        <option value="">-- Select from Inventory or Type Below --</option>
                        ${productOptions}
                    </select>
                    <button type="button" onclick="removeDynamicItem('${key}', ${i})" class="text-[#DC2626] px-1 font-bold">×</button>
                </div>
                <div class="flex gap-1.5 items-center">
                    <input type="text" value="${esc(item.name)}" oninput="updateDynamicItem('${key}', ${i}, 'name', this.value)" placeholder="Custom Supply Name" class="flex-grow min-w-0 px-2 py-1 text-[11px] outline-none">
                    <input type="number" value="${esc(item.cost)}" oninput="updateDynamicItem('${key}', ${i}, 'cost', this.value)" placeholder="Cost" class="w-20 px-2 py-1 text-[11px] outline-none text-right font-medium text-[#C81E5C]">
                </div>
            </div>`;
        }

        return `
        <div class="flex gap-1.5 items-center bg-white p-1.5 rounded-lg border border-[#F2DCE8] mb-1.5">
            <input type="text" value="${esc(item.name)}" oninput="updateDynamicItem('${key}', ${i}, 'name', this.value)" placeholder="Name" class="flex-grow min-w-0 px-2 py-1 text-[11px] outline-none">
            <input type="number" value="${esc(item.cost)}" oninput="updateDynamicItem('${key}', ${i}, 'cost', this.value)" placeholder="Cost" class="w-20 px-2 py-1 text-[11px] outline-none text-right font-medium text-[#C81E5C]">
            <button type="button" onclick="removeDynamicItem('${key}', ${i})" class="text-[#DC2626] px-1 font-bold">×</button>
        </div>`;
    }).join('');
}

window.handleSupplySelect = function(sel, idx) {
    const pId = sel.value;
    if (!pId) return;
    const p = allProductsCache.find(x => x.id === pId);
    if (p) {
        setupData.supplies[idx].name = p.name;
        setupData.supplies[idx].cost = p.cost;
        renderDynamicList('supplies', setupData.supplies);
        calculateTotalExpenses();
    }
};

function addDynamicItem(key) {
    if (!setupData[key]) setupData[key] = [];
    setupData[key].push({ id: localId(), name: '', cost: 0 });
    renderDynamicList(key, setupData[key]);
    calculateTotalExpenses();
    const inputs = $(`${key}List`).querySelectorAll('input[type="text"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
}
function updateDynamicItem(key, index, field, value) {
    if (!setupData[key] || !setupData[key][index]) return;
    setupData[key][index][field] = field === 'cost' ? num(value) : value;
    calculateTotalExpenses();
}
function removeDynamicItem(key, index) {
    setupData[key].splice(index, 1);
    renderDynamicList(key, setupData[key]);
    calculateTotalExpenses();
}

/* ---------- Employees ---------- */
function openEmployeeModal(empId = null) {
    $('editEmpId').value = empId || '';
    const emp = empId ? setupData.employees.find((e) => e.id === empId) : null;
    $('empModalTitle').innerText = emp ? 'Edit Employee' : 'Add Employee';
    $('empName').value = emp ? emp.name : '';
    $('empSalary').value = emp ? emp.salary : '';
    $('empSSS').value = emp ? emp.sss : 0;
    $('empPhilhealth').value = emp ? emp.philhealth : 0;
    $('empPagibig').value = emp ? emp.pagibig : 0;
    $('empTax').value = emp ? emp.tax : 0;
    $('employeeModal').classList.remove('hidden');
    setTimeout(() => $('empName').focus(), 50);
}
function closeEmployeeModal() { $('employeeModal').classList.add('hidden'); }

function saveEmployee() {
    const id = $('editEmpId').value;
    const emp = {
        name: $('empName').value.trim(),
        salary: num($('empSalary').value),
        sss: num($('empSSS').value),
        philhealth: num($('empPhilhealth').value),
        pagibig: num($('empPagibig').value),
        tax: num($('empTax').value)
    };
    if (!emp.name) { showToast('Please enter employee name.', true); return; }

    if (id) {
        const idx = setupData.employees.findIndex((e) => e.id === id);
        if (idx > -1) setupData.employees[idx] = { id, ...emp };
    } else {
        setupData.employees.push({ id: localId(), ...emp });
    }
    closeEmployeeModal();
    renderEmployeesTable();
    calculateTotalExpenses();
    showToast('Employee saved. I-click ang "Save Configuration" para ma-save sa database.');
}

function deleteEmployee(id) {
    const emp = setupData.employees.find((e) => e.id === id);
    if (emp && !confirm(`Delete employee "${emp.name}"?`)) return;
    setupData.employees = setupData.employees.filter((e) => e.id !== id);
    renderEmployeesTable();
    calculateTotalExpenses();
}

function renderEmployeesTable() {
    const tbody = $('employeeTableBody');
    if (!setupData.employees.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="py-3 text-center text-[#B7A7BE]">No employees added yet.</td></tr>`;
        return;
    }
    tbody.innerHTML = setupData.employees.map((emp) => {
        const gov = num(emp.sss) + num(emp.philhealth) + num(emp.pagibig);
        const net = num(emp.salary) - gov - num(emp.tax);
        return `
            <tr class="border-b border-[#FBF1F7] hover:bg-[#FFF9F2]">
                <td class="py-2 px-2 font-medium text-[#2B1B33]">${esc(emp.name)}</td>
                <td class="py-2 px-2">${peso(emp.salary)}</td>
                <td class="py-2 px-2 text-[#8A7690]">${peso(gov)}</td>
                <td class="py-2 px-2 text-[#8A7690]">${peso(emp.tax)}</td>
                <td class="py-2 px-2 font-bold text-[#C81E5C]">${peso(net)}</td>
                <td class="py-2 px-2 text-right space-x-1">
                    <button onclick="generatePayslip(${jsArg(emp.id)})" class="text-[#1F9D55] font-medium hover:underline text-[10px]">Payslip</button>
                    <button onclick="openEmployeeModal(${jsArg(emp.id)})" class="text-[#C81E5C] font-medium hover:underline text-[10px]">Edit</button>
                    <button onclick="deleteEmployee(${jsArg(emp.id)})" class="text-[#DC2626] font-medium hover:underline text-[10px]">Del</button>
                </td>
            </tr>`;
    }).join('');
}

function generatePayslip(empId) {
    const emp = setupData.employees.find((e) => e.id === empId);
    if (!emp) return;
    const f = (n) => num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const totalDed = num(emp.sss) + num(emp.philhealth) + num(emp.pagibig) + num(emp.tax);
    $('payslipDateIssued').innerText = 'Issued: ' + new Date().toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
    $('psName').innerText = emp.name;
    $('psBasic').innerText = f(emp.salary);
    $('psSSS').innerText = f(emp.sss);
    $('psPhilhealth').innerText = f(emp.philhealth);
    $('psPagibig').innerText = f(emp.pagibig);
    $('psTax').innerText = f(emp.tax);
    $('psTotalDeductions').innerText = f(totalDed);
    $('psNetPay').innerText = f(num(emp.salary) - totalDed);
    $('payslipModal').classList.remove('hidden');
}
function closePayslipModal() { $('payslipModal').classList.add('hidden'); }

function calculateTotalExpenses() {
    setupData.rent = num($('setupRent').value);
    const tp = $('setupTargetProfitPercent').value;
    setupData.targetProfitPercent = tp === '' ? 30 : num(tp);

    const t = monthlyTotals(setupData);
    $('totalFixedHeaderDisplay').innerText = `Total: ${peso(t.fixed)}`;
    $('totalVariableHeaderDisplay').innerText = `Total: ${peso(t.variable)}`;
    $('grandTotalOverheadDisplay').innerText = peso(t.total);
}

async function clearSetup() {
    if (!confirm('I-reset ang setup ngayong buwan? Mabubura ang naka-save na expenses at employees para sa buwang ito.')) return;
    try {
        await db.deleteSetup(thisMonthKey());
        savedMonthConfig = null;
        setupData = EMPTY_SETUP();
        $('setupRent').value = 0;
        $('setupTargetProfitPercent').value = 30;
        renderEmployeesTable();
        ['subscriptions', 'utilities', 'packaging', 'marketing', 'permitsMisc', 'supplies'].forEach((k) => renderDynamicList(k, setupData[k]));
        calculateTotalExpenses();
        loadFinancials();
        showToast('Setup cleared.');
    } catch (err) { showToast('Error: ' + err.message, true); }
}

async function saveSetupConfig(evt) {
    calculateTotalExpenses();
    const btn = evt && evt.target;
    setButtonBusy(btn, true, 'Saving...');
    try {
        const data = normalizeSetup(JSON.parse(JSON.stringify(setupData)));
        await db.saveSetup(thisMonthKey(), data);
        savedMonthConfig = data;
        showToast('Setup & Monthly Expenses saved!');
        loadFinancials();
    } catch (err) {
        showToast('Error saving setup: ' + err.message, true);
    } finally {
        setButtonBusy(btn, false);
    }
}

/* ---------------------------------------------------------
   BARCODE SCANNER
--------------------------------------------------------- */
function startScanner(elementId, statusElId, onSuccess) {
    const statusEl = statusElId ? $(statusElId) : null;
    const setStatus = (t) => { if (statusEl) statusEl.innerText = t; };

    if (typeof Html5Qrcode === 'undefined') { showToast('Scanner library failed to load.', true); return; }
    if (!window.isSecureContext && location.hostname !== 'localhost') {
        setStatus('HTTPS required');
        showToast('Camera requires HTTPS or localhost.', true);
        return;
    }

    const begin = () => {
        html5QrCode = new Html5Qrcode(elementId);
        setStatus('Starting...');
        Html5Qrcode.getCameras().then((cameras) => {
            if (!cameras || !cameras.length) { setStatus('No camera'); showToast('Walang nahanap na camera.', true); return; }
            const back = cameras.find((c) => /back|rear|environment/i.test(c.label));
            const camId = (back || cameras[cameras.length - 1]).id;
            let handled = false;
            html5QrCode.start(
                camId,
                { fps: 10, qrbox: { width: 220, height: 120 } },
                (text) => { if (handled) return; handled = true; onSuccess(text); },
                () => {}
            ).then(() => setStatus('Active'))
             .catch((err) => { setStatus('Error'); showToast('Hindi ma-start ang scanner: ' + err, true); });
        }).catch((err) => { setStatus('Denied'); showToast('Camera access denied: ' + err, true); });
    };

    // Laging gumawa ng bagong instance para tama ang target element (reader vs posReader)
    if (html5QrCode && html5QrCode.isScanning) {
        html5QrCode.stop().catch(() => {}).finally(() => { try { html5QrCode.clear(); } catch {} begin(); });
    } else {
        begin();
    }
}

function stopScanner() {
    if (html5QrCode && html5QrCode.isScanning) {
        html5QrCode.stop().then(() => { try { html5QrCode.clear(); } catch {} }).catch(() => {});
    }
    const stat = $('scannerStatus');
    if (stat) stat.innerText = '';
}

function startAddScanner() {
    stopSnapshotCamera();
    startScanner('reader', 'scannerStatus', (text) => {
        $('prodBarcode').value = text;
        stopScanner();
        const existing = allProductsCache.find((p) => p.barcode === text);
        if (existing && !$('editProductId').value) {
            showToast(`Existing na ang barcode (${existing.name}). Binuksan para i-edit.`);
            triggerEdit(existing.id);
        } else {
            showToast('Barcode Scanned: ' + text);
        }
    });
}

function openPosScannerModal() {
    $('posScannerModal').classList.remove('hidden');
    startScanner('posReader', 'posScannerStatus', (text) => {
        closePosScannerModal();
        const item = allProductsCache.find((x) => x.barcode === text);
        if (item) {
            addToCartById(item.id);
            showToast('Added via Scan: ' + item.name);
        } else {
            showToast('Item not found for barcode: ' + text, true);
        }
    });
}

function closePosScannerModal() {
    stopScanner();
    $('posScannerStatus').innerText = '';
    $('posScannerModal').classList.add('hidden');
}

function generateAutoBarcode() {
    let code;
    do { code = 'BPH-' + Math.floor(10000 + Math.random() * 90000); }
    while (allProductsCache.some((p) => p.barcode === code));
    $('prodBarcode').value = code;
}

function downloadBarcodeSticker() {
    const val = $('prodBarcode').value.trim();
    if (!val) { showToast('Please enter or generate a barcode first.', true); return; }
    if (typeof JsBarcode === 'undefined') { showToast('Barcode library failed to load.', true); return; }
    try {
        const canvas = $('stickerCanvas');
        JsBarcode(canvas, val, { format: 'CODE128', displayValue: true, fontSize: 16, margin: 10, width: 2, height: 80 });
        const link = document.createElement('a');
        link.download = `BizStore-Barcode-${val}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
        showToast('Barcode downloaded successfully!');
    } catch (err) {
        showToast('Failed to generate barcode image.', true);
    }
}

/* ---------------------------------------------------------
   PRODUCT PHOTO
--------------------------------------------------------- */
function startSnapshotCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { showToast('Camera not supported (HTTPS required).', true); return; }
    stopScanner();
    const video = $('snapshotVideo');
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then((stream) => {
        snapshotStream = stream;
        video.srcObject = stream;
        video.classList.remove('hidden');
        $('camPlaceholder').classList.add('hidden');
        $('snapshotPreview').classList.add('hidden');
    }).catch((err) => showToast('Hindi ma-access ang camera: ' + err, true));
}

function takeSnapshot() {
    if (!snapshotStream) { showToast('I-click muna ang "Open" para buksan ang camera.', true); return; }
    const video = $('snapshotVideo');
    const canvas = $('snapshotCanvas');
    const preview = $('snapshotPreview');
    // I-resize para hindi mabigat (max 600px)
    const max = 600;
    const scale = Math.min(1, max / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    capturedImageData = canvas.toDataURL('image/jpeg', 0.8);
    preview.src = capturedImageData;
    preview.classList.remove('hidden');
    video.classList.add('hidden');
    stopSnapshotCamera();
}

function stopSnapshotCamera() {
    if (snapshotStream) { snapshotStream.getTracks().forEach((t) => t.stop()); snapshotStream = null; }
    const video = $('snapshotVideo');
    if (video) {
        video.srcObject = null;
        if (!video.classList.contains('hidden')) {
            video.classList.add('hidden');
            if ($('snapshotPreview').classList.contains('hidden')) $('camPlaceholder').classList.remove('hidden');
        }
    }
}

/* ---------------------------------------------------------
   EXPIRY
--------------------------------------------------------- */
const expiryMode = () => document.querySelector('input[name="expiryMode"]:checked').value;

function toggleExpiryMode() {
    const isDate = expiryMode() === 'date';
    $('prodExpiryDate').classList.toggle('hidden', !isDate);
    $('expiryMonthsWrap').classList.toggle('hidden', isDate);
    if (!isDate) updateComputedExpiry();
}

function addMonths(dateStr, months) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setMonth(d.getMonth() + months);
    return ymd(d);
}

function updateComputedExpiry() {
    if (expiryMode() !== 'months') return;
    const months = parseInt($('prodExpiryMonths').value, 10);
    const dateIn = $('prodDate').value;
    $('computedExpiryDisplay').innerText = months && dateIn ? addMonths(dateIn, months) : '-';
}

function computeExpiryDate() {
    if (expiryMode() === 'date') return $('prodExpiryDate').value;
    const months = parseInt($('prodExpiryMonths').value, 10);
    const dateIn = $('prodDate').value;
    return months && dateIn ? addMonths(dateIn, months) : '';
}

function resetExpiryUi() {
    document.querySelector('input[name="expiryMode"][value="date"]').checked = true;
    $('prodExpiryDate').classList.remove('hidden');
    $('prodExpiryDate').value = '';
    $('expiryMonthsWrap').classList.add('hidden');
    $('prodExpiryMonths').value = '';
    $('computedExpiryDisplay').innerText = '-';
}

/* ---------------------------------------------------------
   ADD / EDIT PRODUCT
--------------------------------------------------------- */
function clearSellingPrice() {
    $('prodSellingPrice').value = '';
    updateMarkupPreview();
}

function updateMarkupPreview() {
    const cost = num($('prodCost').value);
    const selling = num($('prodSellingPrice').value);
    const preview = $('markupPreviewText');
    const ts = totalStockOf();
    const cfg = normalizeSetup(savedMonthConfig || setupData);
    const overheadPerUnit = monthlyTotals(cfg).total / (ts > 0 ? ts : 1);
    
    if (selling > 0) {
        const profit = selling - cost - overheadPerUnit;
        const baseTotal = cost + overheadPerUnit;
        const markupPct = baseTotal > 0 ? (profit / baseTotal) * 100 : 0;
        preview.innerText = `₱${profit.toFixed(2)} (${markupPct.toFixed(1)}% markup)`;
        preview.className = profit >= 0 ? 'font-medium text-[#1F9D55]' : 'font-medium text-[#DC2626]';
    } else {
        const price = (cost + overheadPerUnit) * (1 + cfg.targetProfitPercent / 100);
        const profit = price - cost - overheadPerUnit;
        preview.innerText = `Auto: ₱${price.toFixed(2)} (Profit: ₱${profit.toFixed(2)} at ${cfg.targetProfitPercent}%)`;
        preview.className = 'font-medium text-[#2B1B33]';
    }
}

function clearProductForm() {
    $('productForm').reset();
    $('editProductId').value = '';
    $('formTitle').innerText = '✨ Add New Product';
    const btn = $('submitBtn');
    btn.innerText = 'Save Product';
    btn.disabled = false;
    btn.classList.remove('opacity-60', 'cursor-wait');
    $('snapshotPreview').removeAttribute('src');
    $('snapshotPreview').classList.add('hidden');
    $('camPlaceholder').classList.remove('hidden');
    capturedImageData = '';
    editingImage = '';
    $('prodDate').value = ymd(new Date());
    $('prodSellingPrice').value = '';
    $('markupPreviewText').innerText = '-';
    resetExpiryUi();
    loadCategoryDropdowns();
}

async function saveProduct(e) {
    e.preventDefault();
    const btn = $('submitBtn');
    const id = $('editProductId').value;
    const barcode = $('prodBarcode').value.trim();
    const name = $('prodName').value.trim();
    const qty = parseInt($('prodQty').value, 10);
    const cost = num($('prodCost').value);
    const expiryDate = computeExpiryDate();

    if (!name || !barcode) { showToast('Name and barcode are required.', true); return; }
    if (isNaN(qty) || qty < 0) { showToast('Stock Qty must be 0 or higher.', true); return; }
    if (cost < 0) { showToast('Cost cannot be negative.', true); return; }
    if (expiryMode() === 'months' && !expiryDate) { showToast('Please specify months for expiry.', true); return; }

    setButtonBusy(btn, true, 'Saving...');
    try {
        if (await db.barcodeExists(barcode, id || null)) {
            showToast('Barcode already exists!', true);
            return;
        }

        let image = editingImage;
        if (capturedImageData) image = await db.uploadImage(capturedImageData);

        const product = {
            category: $('prodCategory').value,
            barcode, name, cost, qty,
            sellingPrice: num($('prodSellingPrice').value),
            dateIn: $('prodDate').value,
            expiryDate,
            image: image || ''
        };

        if (id) {
            const old = allProductsCache.find((x) => x.id === id);
            const qtyDiff = qty - (old ? old.qty : qty);
            await db.saveProduct(product, id);
            if (qtyDiff !== 0) {
                await db.addLog({ productId: id, productName: name, action: qtyDiff > 0 ? 'Stock Adjustment (In)' : 'Stock Adjustment (Out)', qtyChange: qtyDiff, note: 'Manual update via Add/Edit form' });
            }
            showToast('Product updated successfully!');
        } else {
            const saved = await db.saveProduct(product);
            await db.addLog({ productId: saved.id, productName: name, action: 'Initial Stock In', qtyChange: qty, note: 'New product added' });
            showToast('Product saved successfully!');
        }
        clearProductForm();
        await refreshProducts();
    } catch (err) {
        showToast('Error: ' + err.message, true);
    } finally {
        setButtonBusy(btn, false, $('editProductId').value ? 'Update Product' : 'Save Product');
    }
}

function triggerEdit(id) {
    const p = allProductsCache.find((x) => x.id === id);
    if (!p) return;
    switchTab('input');
    $('formTitle').innerText = '✏️ Edit Product';
    $('submitBtn').innerText = 'Update Product';
    $('editProductId').value = p.id;
    if (p.category && !categories.includes(p.category)) {
        $('prodCategory').insertAdjacentHTML('beforeend', `<option value="${esc(p.category)}">${esc(p.category)}</option>`);
    }
    $('prodCategory').value = p.category;
    $('prodBarcode').value = p.barcode;
    $('prodName').value = p.name;
    $('prodCost').value = p.cost;
    $('prodSellingPrice').value = p.sellingPrice || '';
    $('prodQty').value = p.qty;
    $('prodDate').value = p.dateIn || '';
    updateMarkupPreview();
    resetExpiryUi();
    $('prodExpiryDate').value = p.expiryDate || '';

    capturedImageData = '';
    editingImage = p.image || '';
    if (editingImage) {
        $('snapshotPreview').src = editingImage;
        $('snapshotPreview').classList.remove('hidden');
        $('camPlaceholder').classList.add('hidden');
    } else {
        $('snapshotPreview').classList.add('hidden');
        $('camPlaceholder').classList.remove('hidden');
    }
}

async function deleteProduct(id) {
    const p = allProductsCache.find((x) => x.id === id);
    if (!confirm(`Delete "${p ? p.name : 'this product'}"? Hindi na ito maibabalik.`)) return;
    try {
        await db.deleteProduct(id);
        cart = cart.filter((c) => c.id !== id);
        renderCart();
        await loadInventory();
        showToast('Product deleted.');
    } catch (err) { showToast('Error: ' + err.message, true); }
}

/* ---------------------------------------------------------
   PRODUCTS (shared)
--------------------------------------------------------- */
async function refreshProducts() {
    try {
        const inv = await db.getInventory();
        inv.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        allProductsCache = inv;
    } catch (err) {
        showToast('Hindi ma-load ang products: ' + err.message, true);
    }
    return totalStockOf();
}

function expiryBadge(p) {
    if (!p.expiryDate) return '';
    const days = Math.ceil((new Date(p.expiryDate + 'T00:00:00') - new Date(ymd(new Date()) + 'T00:00:00')) / 86400000);
    if (days < 0) return `<span class="ml-1 text-[8px] px-1 rounded bg-[#FDE3E3] text-[#C81E1E] font-semibold">Expired</span>`;
    if (days <= 30) return `<span class="ml-1 text-[8px] px-1 rounded bg-[#FFF4D6] text-[#9A6B00] font-semibold">${days}d left</span>`;
    return '';
}

/* ---------------------------------------------------------
   POS
--------------------------------------------------------- */
async function loadPosCatalog() {
    const grid = $('posCatalogGrid');
    if (!allProductsCache.length) grid.innerHTML = `<p class="col-span-full text-center text-[#B7A7BE] text-xs py-6">Loading...</p>`;
    await refreshProducts();
    renderPosFilteredProducts();
}

function filterPosByCategory(cat) {
    currentPosCategory = cat;
    loadCategoryDropdowns();
    renderPosFilteredProducts();
}

function renderPosFilteredProducts() {
    const grid = $('posCatalogGrid');
    const totalStock = totalStockOf();
    const filtered = allProductsCache.filter((p) => currentPosCategory === 'All' || p.category === currentPosCategory);
    if (!filtered.length) {
        grid.innerHTML = `<p class="col-span-full text-center text-[#B7A7BE] text-xs py-6">No items. Magdagdag sa "Add / Edit" tab.</p>`;
        return;
    }
    grid.innerHTML = filtered.map((p) => {
        const price = getPrice(p, totalStock);
        const baseCost = Number(p.cost) || 0;
        const cfg = normalizeSetup(savedMonthConfig || setupData);
        const overheadPerUnit = monthlyTotals(cfg).total / (totalStock > 0 ? totalStock : 1);
        const profitAmount = price - baseCost - overheadPerUnit;
        const tooltip = `Cost: ${peso(baseCost)} | Overhead: ${peso(overheadPerUnit)} | Profit: ${peso(profitAmount)}`;
        const out = p.qty <= 0;
        const photo = p.image
            ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" class="w-full aspect-square object-cover">`
            : `<div class="w-full aspect-square bg-[#FBF1F7] flex items-center justify-center text-[8px] text-[#B7A7BE]">No Photo</div>`;
        return `
            <div class="relative group bg-white rounded-lg shadow-sm border border-[#F2DCE8] overflow-visible cursor-pointer flex flex-col transition hover:-translate-y-0.5 hover:shadow-md ${out ? 'opacity-50' : ''}">
                <div onclick="addToCartById(${jsArg(p.id)})" class="flex flex-col flex-grow">
                    ${photo}
                    <div class="p-1.5 flex flex-col flex-grow">
                        <h3 class="font-medium text-[#2B1B33] text-[10px] leading-tight line-clamp-2">${esc(p.name)}${expiryBadge(p)}</h3>
                        <div class="mt-auto flex justify-between items-end pt-1">
                            <span class="text-[#C81E5C] font-bold text-[11px]">${peso(price)}</span>
                            <span class="text-[8px] ${out ? 'text-[#DC2626] font-semibold' : 'text-[#8A7690]'}">${out ? 'Out' : 'Qty:' + p.qty}</span>
                        </div>
                    </div>
                </div>
                
                <!-- Custom Tooltip -->
                <div class="absolute bottom-[105%] left-1/2 -translate-x-1/2 mb-1 w-[140px] z-[999] bg-[#2B1B33] text-white text-[9px] p-2 rounded-lg shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 pointer-events-none">
                    <div class="font-semibold mb-1 border-b border-gray-600 pb-1 text-[#FBF1F7] text-center">Price Breakdown</div>
                    <div class="flex justify-between mt-1"><span>Cost:</span> <span>${peso(baseCost)}</span></div>
                    <div class="flex justify-between mt-0.5"><span>Overhead:</span> <span>${peso(overheadPerUnit)}</span></div>
                    <div class="flex justify-between mt-1 pt-1 border-t border-gray-600 text-[#4ADE80] font-bold"><span>Profit:</span> <span>${peso(profitAmount)}</span></div>
                    <div class="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-[#2B1B33]"></div>
                </div>
            </div>`;
    }).join('');
    filterPosCatalog();
}

function filterPosCatalog() {
    const q = $('posSearch').value.toLowerCase();
    for (const c of $('posCatalogGrid').children) {
        if (c.tagName === 'P') continue;
        c.style.display = c.innerText.toLowerCase().includes(q) ? 'flex' : 'none';
    }
}

function addToCartById(id) {
    const p = allProductsCache.find((x) => x.id === id);
    if (!p) { showToast('Product not found.', true); return; }
    addToCart(p.id, p.name, getPrice(p, totalStockOf()), p.qty);
}

function addToCart(id, name, price, maxQty) {
    if (maxQty <= 0) { showToast('Out of stock!', true); return; }
    const item = cart.find((i) => i.id === id);
    if (item) {
        if (item.qty < maxQty) item.qty++;
        else { showToast('Max stock reached.', true); return; }
    } else {
        cart.push({ id, name, price, qty: 1, maxQty });
    }
    renderCart();
}

function changeCartQty(i, delta) {
    const item = cart[i];
    if (!item) return;
    const next = item.qty + delta;
    if (next <= 0) { cart.splice(i, 1); }
    else if (next > item.maxQty) { showToast('Max stock reached.', true); return; }
    else item.qty = next;
    renderCart();
}

function removeFromCart(i) { cart.splice(i, 1); renderCart(); }
function clearCart() { cart = []; renderCart(); }

function renderCart() {
    const container = $('cartList');
    if (!cart.length) {
        container.innerHTML = `<p class="text-[#B7A7BE] text-center py-4">Cart empty.</p>`;
        $('cartTotalPrice').innerText = '0.00';
        return;
    }
    let total = 0;
    container.innerHTML = cart.map((item, i) => {
        const subtotal = item.price * item.qty;
        total += subtotal;
        return `
            <div class="flex justify-between items-center py-1 border-b border-[#FBF1F7] last:border-0">
                <div class="w-1/2 min-w-0">
                    <p class="font-medium text-[#2B1B33] truncate text-[11px]">${esc(item.name)}</p>
                    <p class="text-[9px] text-[#8A7690]">${peso(item.price)} each</p>
                </div>
                <div class="flex items-center gap-1">
                    <button onclick="changeCartQty(${i}, -1)" class="w-5 h-5 rounded bg-[#FBF1F7] text-[#6B5470] font-bold leading-none">−</button>
                    <span class="w-5 text-center text-[11px] font-semibold">${item.qty}</span>
                    <button onclick="changeCartQty(${i}, 1)" class="w-5 h-5 rounded bg-[#FBF1F7] text-[#6B5470] font-bold leading-none">+</button>
                </div>
                <div class="flex items-center gap-1.5">
                    <span class="font-semibold text-[#2B1B33] text-[11px]">${peso(subtotal)}</span>
                    <button onclick="removeFromCart(${i})" class="text-[#DC2626] hover:text-red-700 bg-[#FFF9F2] px-1.5 rounded font-bold">×</button>
                </div>
            </div>`;
    }).join('');
    $('cartTotalPrice').innerText = total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function openCheckoutModal(evt) {
    if (!cart.length) { showToast('Cart is empty.', true); return; }
    $('checkoutModal').classList.remove('hidden');
    $('checkoutCustomer').value = '';
    $('checkoutType').value = 'regular';
    $('checkoutPayment').value = 'paid';
}

function closeCheckoutModal() {
    $('checkoutModal').classList.add('hidden');
}

async function confirmCheckout(evt) {
    const btn = evt.target;
    const cust = $('checkoutCustomer').value.trim();
    const type = $('checkoutType').value;
    const payment = $('checkoutPayment').value;
    const paid = payment === 'paid';
    
    setButtonBusy(btn, true, 'Processing...');
    try {
        const items = cart.map((i) => ({ id: i.id, qty: i.qty, price: i.price }));
        await db.checkout(items, cust, type, paid);
        showToast('Checkout Complete!');
        clearCart();
        closeCheckoutModal();
        await loadPosCatalog();
        if (typeof loadOrders === 'function') loadOrders();
    } catch (err) {
        showToast('Checkout failed: ' + err.message, true);
    } finally {
        setButtonBusy(btn, false, 'Confirm Checkout');
    }
}

/* ---------------------------------------------------------
   INVENTORY
--------------------------------------------------------- */
async function loadInventory() {
    const tbody = $('inventoryTableBody');
    if (!allProductsCache.length) tbody.innerHTML = `<tr><td colspan="5" class="py-4 text-center text-[#B7A7BE]">Loading...</td></tr>`;
    await refreshProducts();
    renderInventoryTable();
}

function filterInventoryByCategory(cat) {
    currentInventoryCategory = cat;
    loadCategoryDropdowns();
    renderInventoryTable();
}

function renderInventoryTable() {
    const tbody = $('inventoryTableBody');
    const totalStock = totalStockOf();
    const filtered = allProductsCache.filter((p) => currentInventoryCategory === 'All' || p.category === currentInventoryCategory);
    if (!filtered.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="py-4 text-center text-[#B7A7BE]">No records.</td></tr>`;
        return;
    }
    tbody.innerHTML = filtered.map((p) => {
        const price = getPrice(p, totalStock);
        const low = p.qty <= 5;
        return `
            <tr class="hover:bg-[#FFF9F2]">
                <td class="py-2 px-1 flex items-center gap-1.5">
                    ${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" class="w-6 h-6 rounded object-cover">` : `<div class="w-6 h-6 bg-[#FBF1F7] rounded"></div>`}
                    <span class="font-medium text-[#2B1B33] max-w-[10rem] truncate" title="${esc(p.name)}">${esc(p.name)}</span>${expiryBadge(p)}
                </td>
                <td class="py-2 px-1 text-[#6B5470]">${esc(p.category)}</td>
                <td class="py-2 px-1 font-semibold text-[#C81E5C]">${peso(price)}</td>
                <td class="py-2 px-1 font-medium ${low ? 'text-[#DC2626]' : 'text-[#6B5470]'}">${p.qty}${low ? ' ⚠️' : ''}</td>
                <td class="py-2 px-1 text-right space-x-1">
                    <button onclick="viewLogs(${jsArg(p.id)}, ${jsArg(p.name)})" class="text-[#1F9D55] hover:underline text-[10px]">Logs</button>
                    <button onclick="triggerEdit(${jsArg(p.id)})" class="text-[#C81E5C] hover:underline mr-1 text-[10px]">Edit</button>
                    <button onclick="deleteProduct(${jsArg(p.id)})" class="text-[#DC2626] hover:underline text-[10px]">Del</button>
                </td>
            </tr>`;
    }).join('');
    filterInventory();
}

function filterInventory() {
    const q = $('searchInventory').value.toLowerCase();
    for (const r of $('inventoryTableBody').getElementsByTagName('tr')) {
        r.style.display = r.innerText.toLowerCase().includes(q) ? '' : 'none';
    }
}

/* ---------- Logs ---------- */
function formatDateTime(ms) {
    const d = new Date(ms);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function viewLogs(productId, productName) {
    $('logProductName').innerText = productName;
    const tbody = $('logsTableBody');
    tbody.innerHTML = `<tr><td colspan="4" class="py-4 text-center text-[#B7A7BE]">Loading...</td></tr>`;
    $('logsModal').classList.remove('hidden');
    try {
        const logs = await db.getLogs(productId);
        if (!logs.length) {
            tbody.innerHTML = `<tr><td colspan="4" class="py-4 text-center text-[#B7A7BE]">No history yet.</td></tr>`;
            return;
        }
        tbody.innerHTML = logs.map((log) => {
            const pos = log.qtyChange > 0;
            return `
                <tr class="hover:bg-[#FFF9F2]">
                    <td class="py-2 px-2 text-[10px] text-[#6B5470] whitespace-nowrap">${formatDateTime(log.timestamp)}</td>
                    <td class="py-2 px-2 text-[10px] font-medium text-[#2B1B33]">${esc(log.action)}</td>
                    <td class="py-2 px-2 text-[10px] font-bold ${pos ? 'text-[#1F9D55]' : 'text-[#C81E5C]'}">${pos ? '+' : ''}${log.qtyChange}</td>
                    <td class="py-2 px-2 text-[10px] text-[#6B5470] truncate max-w-[140px]" title="${esc(log.note)}">${esc(log.note)}</td>
                </tr>`;
        }).join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="4" class="py-4 text-center text-[#DC2626]">${esc(err.message)}</td></tr>`;
    }
}
function closeLogsModal() { $('logsModal').classList.add('hidden'); }

/* ---------------------------------------------------------
   ONE-TIME MIGRATION: localStorage → Supabase
--------------------------------------------------------- */
async function maybeMigrateLocalData() {
    if (db.mode !== 'supabase' || LS.get('bizstore_migrated', false)) return;
    const localInv = LS.get('bizstore_inventory', []);
    const setupKeys = Object.keys(localStorage).filter((k) => k.startsWith('bizConfig_v6_'));
    if (!localInv.length && !setupKeys.length) { LS.set('bizstore_migrated', true); return; }

    if (!confirm(`May nakitang lumang data sa browser na ito (${localInv.length} products). I-upload sa bagong Supabase database?`)) {
        LS.set('bizstore_migrated', true);
        return;
    }

    showToast('Migrating data to Supabase...');
    try {
        const sb = db.client;
        // Categories
        const localCats = LS.get('bizCategories', []);
        if (localCats.length) await sb.from('categories').upsert(localCats.map((name) => ({ name })), { onConflict: 'name', ignoreDuplicates: true });

        // Products (upload photos to storage)
        const idMap = {};
        for (const p of localInv) {
            let image = p.image || '';
            if (image.startsWith('data:')) { try { image = await db.uploadImage(image); } catch { image = ''; } }
            const row = productToRow({ ...p, image, cost: num(p.cost), qty: parseInt(p.qty, 10) || 0 });
            const saved = check(await sb.from('products').upsert(row, { onConflict: 'barcode' }).select('id').single());
            idMap[p.id] = saved.id;
        }

        // Logs
        const logs = LS.get('bizstore_logs', []).map((l) => ({
            product_id: idMap[l.productId] || null,
            product_name: (localInv.find((p) => p.id === l.productId) || {}).name || null,
            action: l.action, qty_change: l.qtyChange || 0, revenue: revenueOf(l),
            note: l.note || null, created_at: new Date(l.timestamp || Date.now()).toISOString()
        }));
        for (let i = 0; i < logs.length; i += 500) check(await sb.from('stock_logs').insert(logs.slice(i, i + 500)));

        // Setup configs
        for (const k of setupKeys) {
            const data = LS.get(k, null);
            if (data) check(await sb.from('setup_configs').upsert({ month: k.replace('bizConfig_v6_', ''), data: normalizeSetup(data) }));
        }

        LS.set('bizstore_migrated', true);
        showToast('Migration complete! Nasa Supabase na ang data mo.');
        categories = await db.getCategories();
        loadCategoryDropdowns();
        await loadSetupConfigToUi();
        await loadPosCatalog();
    } catch (err) {
        showToast('Migration failed: ' + err.message, true);
    }
}

/* ---------------------------------------------------------
   ORDERS TAB
--------------------------------------------------------- */
async function loadOrders() {
    if (db.mode !== 'supabase') {
        $('ordersTableBody').innerHTML = `<tr><td colspan="8" class="py-4 text-center text-[#B7A7BE]">Orders only available in Supabase mode for now.</td></tr>`;
        return;
    }
    const filter = $('ordersStatusFilter').value;
    const tbody = $('ordersTableBody');
    tbody.innerHTML = `<tr><td colspan="8" class="py-4 text-center text-[#B7A7BE]">Loading orders...</td></tr>`;
    try {
        const orders = await db.getOrders(filter);
        if (!orders.length) {
            tbody.innerHTML = `<tr><td colspan="8" class="py-4 text-center text-[#B7A7BE]">No orders found.</td></tr>`;
            return;
        }
        tbody.innerHTML = orders.map(o => {
            const date = new Date(o.created_at).toLocaleDateString();
            const idShort = o.id.split('-')[0];
            const statColor = o.status === 'cancelled' ? 'text-[#DC2626]' : (o.status === 'pending' ? 'text-[#9A6B00]' : 'text-[#1F9D55]');
            const payColor = o.payment_status === 'unpaid' ? 'text-[#DC2626]' : 'text-[#1F9D55]';
            let actions = '';
            if (o.status === 'pending') actions += `<button onclick="releaseOrder('${o.id}')" class="text-[#1F9D55] hover:underline mr-2 text-[10px]">Release</button>`;
            if (o.status !== 'cancelled') actions += `<button onclick="cancelOrder('${o.id}')" class="text-[#DC2626] hover:underline text-[10px]">Cancel</button>`;
            
            return `
                <tr class="hover:bg-[#FFF9F2] search-row border-b border-[#FBF1F7]">
                    <td class="py-2 px-2 text-[#6B5470]">${idShort}</td>
                    <td class="py-2 px-2">${date}</td>
                    <td class="py-2 px-2 font-medium customer-name">${esc(o.customer_name || 'Walk-in')}</td>
                    <td class="py-2 px-2 uppercase text-[10px]">${o.order_type}</td>
                    <td class="py-2 px-2 uppercase text-[10px] font-semibold ${payColor}">${o.payment_status}</td>
                    <td class="py-2 px-2 font-bold text-[#C81E5C]">${peso(o.total)}</td>
                    <td class="py-2 px-2 uppercase text-[10px] font-semibold ${statColor}">${o.status}</td>
                    <td class="py-2 px-2 text-right">${actions}</td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="8" class="py-4 text-center text-[#DC2626]">${esc(err.message)}</td></tr>`;
    }
}

function filterOrdersUi() {
    const q = $('searchOrders').value.toLowerCase();
    for (const r of $('ordersTableBody').querySelectorAll('.search-row')) {
        const name = r.querySelector('.customer-name').innerText.toLowerCase();
        r.style.display = name.includes(q) ? '' : 'none';
    }
}

async function releaseOrder(id) {
    if (!confirm('Release this pre-order? Mababawasan na ang inventory stock.')) return;
    try {
        await db.releaseOrder(id);
        showToast('Order released successfully');
        loadOrders();
        refreshProducts();
    } catch (err) { showToast('Error: ' + err.message, true); }
}

async function cancelOrder(id) {
    if (!confirm('Cancel this order? If released, babalik ang stock sa inventory.')) return;
    try {
        await db.cancelOrder(id);
        showToast('Order cancelled');
        loadOrders();
        refreshProducts();
    } catch (err) { showToast('Error: ' + err.message, true); }
}

/* ---------------------------------------------------------
   SCHEDULE / APPOINTMENTS
--------------------------------------------------------- */
let currentScheduleMonth = new Date();

function changeScheduleMonth(delta) {
    currentScheduleMonth.setMonth(currentScheduleMonth.getMonth() + delta);
    loadSchedule();
}

async function loadSchedule() {
    if (db.mode !== 'supabase') {
        $('scheduleList').innerHTML = `<p class="text-center text-[#B7A7BE] text-xs">Calendar only available in Supabase mode.</p>`;
        return;
    }
    const y = currentScheduleMonth.getFullYear();
    const m = currentScheduleMonth.getMonth();
    $('scheduleMonthYear').innerText = currentScheduleMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    
    const start = new Date(y, m, 1).toISOString().split('T')[0];
    const end = new Date(y, m + 1, 0).toISOString().split('T')[0];
    
    try {
        const { data, error } = await db.client.from('appointments')
            .select('*').gte('appt_date', start).lte('appt_date', end).order('appt_date').order('appt_time');
        if (error) throw error;
        
        $('scheduleList').innerHTML = data.length ? data.map(a => `
            <div class="bg-white p-2 rounded border border-[#F2DCE8] flex justify-between items-center text-xs">
                <div>
                    <p class="font-bold text-[#2B1B33]">${esc(a.appt_date)} <span class="text-[#8A7690] font-normal">${(a.appt_time || '').slice(0,5)}</span></p>
                    <p class="font-medium text-[#C81E5C]">${esc(a.service)}</p>
                    <p class="text-[#6B5470]">${esc(a.client_name)}</p>
                </div>
                <div>
                    <span class="px-2 py-0.5 rounded-full text-[9px] uppercase font-bold bg-[#FBF1F7] text-[#6B5470]">${a.status}</span>
                </div>
            </div>
        `).join('') : '<p class="text-xs text-[#8A7690]">No appointments this month.</p>';

        const today = new Date().toISOString().split('T')[0];
        const { data: nextData } = await db.client.from('appointments')
            .select('*').gte('appt_date', today).in('status', ['scheduled']).order('appt_date').order('appt_time').limit(5);
            
        $('upNextAppointments').innerHTML = (nextData && nextData.length) ? nextData.map(a => `
            <div class="text-[10px] border-b border-[#F2DCE8] pb-1">
                <span class="font-bold text-[#2B1B33]">${esc(a.appt_date)}</span> - <span class="text-[#C81E5C]">${esc(a.service)}</span> (${esc(a.client_name)})
            </div>
        `).join('') : '<p class="text-[10px] text-[#8A7690]">None upcoming.</p>';
        
    } catch (err) {
        $('scheduleList').innerHTML = `<p class="text-red-500">${esc(err.message)}</p>`;
    }
}

function openAppointmentModal() {
    $('apptCustomer').value = '';
    $('apptTitle').value = 'Gluta Inject';
    $('apptDate').value = ymd(new Date());
    $('apptTime').value = '10:00';
    $('appointmentModal').classList.remove('hidden');
}
function closeAppointmentModal() { $('appointmentModal').classList.add('hidden'); }

async function saveAppointment(e) {
    const btn = e.target;
    const client = $('apptCustomer').value.trim();
    const service = $('apptTitle').value.trim();
    const date = $('apptDate').value;
    const time = $('apptTime').value;
    
    if (!client || !service || !date) { showToast('Please fill out details', true); return; }
    
    setButtonBusy(btn, true, 'Saving...');
    try {
        const { error } = await db.client.from('appointments').insert({
            client_name: client, service: service, appt_date: date, appt_time: time
        });
        if (error) throw error;
        showToast('Appointment Saved!');
        closeAppointmentModal();
        loadSchedule();
    } catch (err) {
        showToast(err.message, true);
    } finally {
        setButtonBusy(btn, false, 'Save Schedule');
    }
}

/* ---------------------------------------------------------
   KEYBOARD & MODAL UX
--------------------------------------------------------- */
function wireUx() {
    $('newCategoryInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCategory(); } });

    // I-click ang madilim na background para isara ang modal
    const closers = { categoryModal: closeCategoryModal, employeeModal: closeEmployeeModal, payslipModal: closePayslipModal, posScannerModal: closePosScannerModal, logsModal: closeLogsModal, checkoutModal: closeCheckoutModal, appointmentModal: closeAppointmentModal };
    Object.entries(closers).forEach(([id, fn]) => {
        $(id).addEventListener('click', (e) => { if (e.target.id === id) fn(); });
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        Object.entries(closers).forEach(([id, fn]) => { if (!$(id).classList.contains('hidden')) fn(); });
    });

    window.addEventListener('beforeunload', () => { stopSnapshotCamera(); stopScanner(); });
}

/* ---------------------------------------------------------
   INIT
--------------------------------------------------------- */
async function initApp() {
    if (isSupabaseConfigured()) {
        try {
            const sdb = createSupabaseDb();
            await sdb.init();
            db = sdb;
        } catch (err) {
            db = localDb;
            showToast(err.message + ' (offline mode muna)', true);
        }
    } else {
        db = localDb;
    }
    setDbStatus();
    wireUx();

    try { categories = await db.getCategories(); } catch (err) { showToast(err.message, true); }
    clearProductForm();
    loadCategoryDropdowns();
    renderCart();
    await loadSetupConfigToUi();
    await loadPosCatalog();
    maybeMigrateLocalData();
}

document.addEventListener('DOMContentLoaded', initApp);
