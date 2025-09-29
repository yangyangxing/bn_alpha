(function () {
  'use strict';

  const API_URL = 'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list';
  const EXCHANGE_INFO_URL = 'https://www.binance.com/bapi/defi/v1/public/alpha-trade/get-exchange-info';
  const AGG_TRADES_URL = 'https://www.binance.com/bapi/defi/v1/public/alpha-trade/agg-trades';
  const KLINES_URL = 'https://www.binance.com/bapi/defi/v1/public/alpha-trade/klines';

  /** @type {HTMLInputElement} */
  const searchInput = document.getElementById('searchInput');
  /** @type {HTMLSelectElement} */
  const chainFilter = document.getElementById('chainFilter');
  /** @type {HTMLSelectElement} */
  const cexFilter = document.getElementById('cexFilter');
  const loadingEl = document.getElementById('loading');
  const errorEl = document.getElementById('error');
  const tbody = document.getElementById('tokenTbody');
  const pageInfo = document.getElementById('pageInfo');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const pageSizeSel = document.getElementById('pageSize');
  const table = document.getElementById('tokenTable');
  const onlyNewChk = document.getElementById('onlyNewChk');

  /** @typedef {{name:string,symbol:string,iconUrl:string,chainId:string,chainName:string,price:string,percentChange24h:string,volume24h:string,marketCap:string,contractAddress:string,listingCex:boolean,cexCoinName:string,alphaId?:string,listingTime?:number}} Token */

  /** @type {Token[]} */
  let allTokens = [];
  /** @type {Token[]} */
  let filteredTokens = [];

  let sortKey = 'volume24h';
  let sortDir = 'desc'; // 'asc' | 'desc'
  let pageIndex = 0;

  /** @type {Set<string>} */
  let availableSymbols = new Set();
  /** @type {Map<string, number>} */
  const notionalCache = new Map(); // key: `${symbol}-${start}-${end}` -> number
  /** @type {Map<string, {price:number, time:number}>} */
  const priceWindow = new Map(); // key: symbol -> last snapshot for stability
  /** @type {Map<string, {running:boolean, cell:HTMLTableCellElement, token:any, history:Array<{minP:number,maxP:number}>}>} */
  const stabilityWatchers = new Map();
  let monitoringActive = false;

  function formatNumber(value, fractionDigits = 2) {
    if (value == null || value === '' || isNaN(Number(value))) return '-';
    const num = Number(value);
    const abs = Math.abs(num);
    const formatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: fractionDigits });
    if (abs >= 1_000_000_000) return formatter.format(num / 1_000_000_000) + 'B';
    if (abs >= 1_000_000) return formatter.format(num / 1_000_000) + 'M';
    if (abs >= 1_000) return formatter.format(num / 1_000) + 'K';
    return formatter.format(num);
  }

  function formatPrice(value) {
    if (value == null || value === '' || isNaN(Number(value))) return '-';
    const num = Number(value);
    const decimals = num < 1 ? 6 : 2;
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals }).format(num);
  }

  function setLoading(isLoading, message = '正在加载数据...') {
    loadingEl.textContent = message;
    loadingEl.hidden = !isLoading;
  }

  function setError(message) {
    if (!message) {
      errorEl.hidden = true;
      errorEl.textContent = '';
      return;
    }
    errorEl.hidden = false;
    errorEl.textContent = message;
  }

  function dedupeChains(tokens) {
    const map = new Map();
    for (const t of tokens) {
      if (!map.has(t.chainId)) map.set(t.chainId, t.chainName || t.chainId);
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }

  function applyFilters() {
    const keyword = (searchInput.value || '').trim().toLowerCase();
    const chain = chainFilter.value;
    const cex = cexFilter.value; // '', 'true', 'false'
    filteredTokens = allTokens.filter(t => {
      const matchesKeyword = !keyword ||
        (t.name && t.name.toLowerCase().includes(keyword)) ||
        (t.symbol && t.symbol.toLowerCase().includes(keyword)) ||
        (t.contractAddress && t.contractAddress.toLowerCase().includes(keyword));
      const matchesChain = !chain || t.chainId === chain;
      const matchesCex = !cex || String(Boolean(t.listingCex)) === cex;
      const matchesNew = !onlyNewChk.checked || isListedWithinDays(t, 30);
      return matchesKeyword && matchesChain && matchesCex && matchesNew;
    });
    applySort();
    pageIndex = 0;
    renderPage();
  }

  function applySort() {
    const key = sortKey;
    const dir = sortDir === 'asc' ? 1 : -1;
    filteredTokens.sort((a, b) => {
      const va = a[key];
      const vb = b[key];
      // 对动态计算的列提供排序支持（缓存值）
      if (key === 'dayNotional' || key === 'prevNotional' || key === 'stability') {
        const na = Number(a[key]);
        const nb = Number(b[key]);
        if (!isNaN(na) && !isNaN(nb)) return (na - nb) * dir;
      }
      const na = Number(va);
      const nb = Number(vb);
      const aNum = !isNaN(na) ? na : (va || '').toString().toLowerCase();
      const bNum = !isNaN(nb) ? nb : (vb || '').toString().toLowerCase();
      if (typeof aNum === 'number' && typeof bNum === 'number') return (aNum - bNum) * dir;
      return aNum > bNum ? dir : aNum < bNum ? -dir : 0;
    });
  }

  function renderPage() {
    const pageSize = Number(pageSizeSel.value);
    const total = filteredTokens.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (pageIndex >= totalPages) pageIndex = totalPages - 1;
    const start = pageIndex * pageSize;
    const end = Math.min(start + pageSize, total);
    const current = filteredTokens.slice(start, end);

    tbody.innerHTML = '';
    if (current.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 9;
      td.textContent = '没有数据';
      td.style.color = '#94a3b8';
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      const frag = document.createDocumentFragment();
      for (const t of current) {
        const tr = document.createElement('tr');

        const tdChk = document.createElement('td');
        tdChk.innerHTML = '<input type="checkbox">';
        tr.appendChild(tdChk);

        const tdSym = document.createElement('td');
        const isNew = isListedWithinDays(t, 30);
        const iconImg = t.iconUrl ? `<img alt="${t.symbol || ''}" src="${t.iconUrl}" onerror="this.style.visibility='hidden'">` : '';
        tdSym.innerHTML = `<span class="symbol-cell">${iconImg}<strong>${t.symbol || '-'}</strong>${isNew ? '<span class="symbol-badge">NEW</span>' : ''}</span>`;
        tr.appendChild(tdSym);

        const tdChain = document.createElement('td');
        tdChain.innerHTML = `<span class="chip">${t.chainName || t.chainId || '-'}</span>`;
        tr.appendChild(tdChain);

        const tdPrice = document.createElement('td');
        tdPrice.className = 'numeric';
        tdPrice.textContent = formatPrice(t.price);
        tr.appendChild(tdPrice);

        const tdPct = document.createElement('td');
        tdPct.className = 'numeric ' + (Number(t.percentChange24h) >= 0 ? 'pct-pos' : 'pct-neg');
        const pctVal = Number(t.percentChange24h);
        tdPct.textContent = isNaN(pctVal) ? '-' : pctVal.toFixed(2) + '%';
        tr.appendChild(tdPct);

        const tdVol = document.createElement('td');
        tdVol.className = 'numeric';
        tdVol.textContent = formatNumber(t.volume24h, 2);
        tr.appendChild(tdVol);

        const tdMc = document.createElement('td');
        tdMc.className = 'numeric';
        tdMc.textContent = formatNumber(t.marketCap, 2);
        tr.appendChild(tdMc);

        const tdStb = document.createElement('td');
        tdStb.className = 'numeric stability-paused';
        tdStb.textContent = '停止监控';
        tr.appendChild(tdStb);

        const tdDay = document.createElement('td');
        tdDay.className = 'numeric';
        tdDay.textContent = '…';
        tr.appendChild(tdDay);

        const tdPrev = document.createElement('td');
        tdPrev.className = 'numeric';
        tdPrev.textContent = '…';
        tr.appendChild(tdPrev);

        // 异步填充限价额（Alpha仅支持LIMIT ≈ 全部成交额）
        fillDailyNotionalsIfPossible(t, tdDay, tdPrev).catch(() => {
          tdDay.textContent = '-';
          tdPrev.textContent = '-';
        });

        // 监控不在渲染时自动启动。只有勾选并点击“开始监控”按钮才会启动。

        frag.appendChild(tr);
      }
      tbody.appendChild(frag);
    }

    pageInfo.textContent = `第 ${total === 0 ? 0 : pageIndex + 1} / ${Math.max(1, Math.ceil(total / pageSize))} 页`;
    prevBtn.disabled = pageIndex <= 0;
    nextBtn.disabled = pageIndex >= Math.ceil(total / pageSize) - 1;
  }

  function shorten(addr) {
    if (!addr) return '';
    return addr.slice(0, 6) + '...' + addr.slice(-4);
  }

  function isListedWithinDays(token, days) {
    const ts = Number(token.listingTime);
    if (!ts || Number.isNaN(ts)) return false;
    const now = Date.now();
    const diff = now - ts;
    return diff >= 0 && diff <= days * 24 * 60 * 60 * 1000;
  }

  function buildExplorerUrl(t) {
    const ca = t.contractAddress;
    if (!ca) return '#';
    const chainId = String(t.chainId || '');
    if (chainId === '56' || (t.chainName || '').toLowerCase().includes('bsc')) {
      return `https://bscscan.com/token/${ca}`;
    }
    if (chainId === '8453' || (t.chainName || '').toLowerCase() === 'base') {
      return `https://basescan.org/token/${ca}`;
    }
    // Fallback: google search
    return `https://www.google.com/search?q=${encodeURIComponent(ca + ' explorer')}`;
  }

  async function fetchTokens() {
    setLoading(true);
    setError('');
    try {
      const [listRes, exRes] = await Promise.all([
        fetch(API_URL, { headers: { 'accept': 'application/json' } }),
        fetch(EXCHANGE_INFO_URL, { headers: { 'accept': 'application/json' } })
      ]);
      if (!listRes.ok) throw new Error('网络错误: ' + listRes.status);
      if (!exRes.ok) throw new Error('网络错误: ' + exRes.status);
      const json = await listRes.json();
      const ex = await exRes.json();
      const arr = (json && json.data) || [];
      allTokens = arr.map(normalizeToken);
      filteredTokens = allTokens.slice();
      availableSymbols = new Set(((ex && ex.data && ex.data.symbols) || []).map(s => s.symbol));
      populateChainOptions(allTokens);
      applySort();
      renderPage();
    } catch (err) {
      console.error(err);
      setError('加载失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }

  function normalizeToken(raw) {
    return {
      name: raw.name,
      symbol: raw.symbol,
      iconUrl: raw.iconUrl,
      chainId: String(raw.chainId || ''),
      chainName: raw.chainName,
      chainIconUrl: raw.chainIconUrl,
      price: raw.price,
      percentChange24h: raw.percentChange24h,
      volume24h: raw.volume24h,
      marketCap: raw.marketCap,
      contractAddress: raw.contractAddress,
      listingCex: Boolean(raw.listingCex),
      cexCoinName: raw.cexCoinName,
      listingTime: raw.listingTime,
      alphaId: raw.alphaId,
    };
  }

  function getUtcDayRange(offsetDays) {
    const now = new Date();
    const utcYear = now.getUTCFullYear();
    const utcMonth = now.getUTCMonth();
    const utcDate = now.getUTCDate() + offsetDays;
    const start = Date.UTC(utcYear, utcMonth, utcDate, 0, 0, 0, 0);
    const end = Date.UTC(utcYear, utcMonth, utcDate + 1, 0, 0, 0, 0);
    return { start, end };
  }

  function chooseSymbol(token) {
    const base = token.alphaId || '';
    if (!base) return null;
    const s1 = `${base}USDT`;
    const s2 = `${base}USDC`;
    if (availableSymbols.has(s1)) return s1;
    if (availableSymbols.has(s2)) return s2;
    return null;
  }

  async function fillDailyNotionalsIfPossible(token, tdDay, tdPrev) {
    const sym = chooseSymbol(token);
    if (!sym) { tdDay.textContent = '-'; tdPrev.textContent = '-'; return; }
    const today = getUtcDayRange(0);
    const prev = getUtcDayRange(-1);
    const [n1, n2] = await Promise.all([
      getNotional(sym, today.start, today.end),
      getNotional(sym, prev.start, prev.end),
    ]);
    tdDay.textContent = formatNumber(n1, 2);
    tdPrev.textContent = formatNumber(n2, 2);
    // 将值缓存到 token 对象，便于排序
    token.dayNotional = n1;
    token.prevNotional = n2;
  }

  async function getNotional(symbol, start, end) {
    const key = `${symbol}-${start}-${end}`;
    if (notionalCache.has(key)) return notionalCache.get(key);
    let fromId = undefined;
    let total = 0;
    const limit = 1000;
    for (let i = 0; i < 20; i++) { // 最多拉取 20 * 1000 条聚合记录
      const url = new URL(AGG_TRADES_URL);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('startTime', String(start));
      url.searchParams.set('endTime', String(end));
      url.searchParams.set('limit', String(limit));
      if (fromId != null) url.searchParams.set('fromId', String(fromId));
      const res = await fetch(url.toString(), { headers: { 'accept': 'application/json' } });
      if (!res.ok) break;
      const data = await res.json();
      const list = Array.isArray(data?.data) ? data.data : [];
      if (list.length === 0) break;
      for (const it of list) {
        const p = Number(it.p || it.price || 0);
        const q = Number(it.q || it.qty || 0);
        if (!isNaN(p) && !isNaN(q)) total += p * q;
      }
      const last = list[list.length - 1];
      const lastId = Number(last?.a ?? last?.lastId);
      if (!isNaN(lastId)) fromId = lastId + 1; else break;
      if (list.length < limit) break;
    }
    notionalCache.set(key, total);
    return total;
  }

  async function monitorStability(token, cell) {
    const sym = chooseSymbol(token);
    if (!sym) { cell.textContent = '-'; return; }
    // 若已在监控，更新 cell 引用并返回
    const prev = stabilityWatchers.get(sym);
    if (prev) { prev.cell = cell; prev.token = token; return; }
    stabilityWatchers.set(sym, { running: true, cell, token, history: [] });
    while (stabilityWatchers.get(sym)?.running) {
      // 每3秒请求一次，取3秒窗口内价格最大、最小
      const windowData = await getWindowMinMax(sym, 3_000);
      await delay(3_000);
      const watcher = stabilityWatchers.get(sym);
      if (!watcher) break;
      const c = watcher.cell; const t = watcher.token;
      if (!windowData) { c.textContent = '-'; c.className = 'numeric stability-paused'; continue; }
      // 维护 3 段 3s 窗口的历史
      watcher.history.push(windowData);
      if (watcher.history.length > 3) watcher.history.shift();

      // 3s 判断
      const cur = windowData;
      const th3 = cur.minP / 100000;
      const diff3 = cur.maxP - cur.minP;
      if (diff3 > th3) {
        c.textContent = '波动';
        c.className = 'numeric stability-volatile';
        t.stability = 0;
        continue;
      }
      // 6s 判断（最近两段）
      let level = '微稳';
      let cls = 'numeric stability-mid';
      if (watcher.history.length >= 2) {
        const last2 = watcher.history.slice(-2);
        const min6 = Math.min(last2[0].minP, last2[1].minP);
        const max6 = Math.max(last2[0].maxP, last2[1].maxP);
        const th6 = min6 / 100000;
        if (max6 - min6 <= th6) {
          level = '稳';
          cls = 'numeric stability-stable';
        }
      }
      // 9s 判断（最近三段）
      if (watcher.history.length >= 3) {
        const last3 = watcher.history.slice(-3);
        const min9 = Math.min(last3[0].minP, last3[1].minP, last3[2].minP);
        const max9 = Math.max(last3[0].maxP, last3[1].maxP, last3[2].maxP);
        const th9 = min9 / 100000;
        if (max9 - min9 <= th9) {
          level = '极稳';
          cls = 'numeric stability-ok';
        }
      }
      c.textContent = level;
      c.className = cls;
      t.stability = level === '极稳' ? 3 : level === '稳' ? 2 : 1;
    }
  }

  function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

  async function getLatestPrice(symbol) {
    try {
      // 使用 3 秒窗口内的 agg trades 价格区间来判定波动
      const end = Date.now();
      const start = end - 3 * 1000;
      const url = new URL(AGG_TRADES_URL);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('startTime', String(start));
      url.searchParams.set('endTime', String(end));
      url.searchParams.set('limit', '1000');
      const res = await fetch(url.toString(), { headers: { 'accept': 'application/json' } });
      if (!res.ok) return null;
      const data = await res.json();
      const list = Array.isArray(data?.data) ? data.data : [];
      if (list.length === 0) return null;
      let minP = Infinity, maxP = -Infinity;
      for (const it of list) {
        const p = Number(it.p || it.price || 0);
        if (!isNaN(p)) { if (p < minP) minP = p; if (p > maxP) maxP = p; }
      }
      if (!isFinite(minP) || !isFinite(maxP)) return null;
      // 返回区间中心价作为窗口代表价
      return (minP + maxP) / 2;
    } catch (e) {
      return null;
    }
  }

  async function getWindowMinMax(symbol, windowMs) {
    try {
      const end = Date.now();
      const start = end - windowMs;
      const url = new URL(AGG_TRADES_URL);
      url.searchParams.set('symbol', symbol);
      url.searchParams.set('startTime', String(start));
      url.searchParams.set('endTime', String(end));
      url.searchParams.set('limit', '1000');
      const res = await fetch(url.toString(), { headers: { 'accept': 'application/json' } });
      if (!res.ok) return null;
      const data = await res.json();
      const list = Array.isArray(data?.data) ? data.data : [];
      if (list.length === 0) return null;
      let minP = Infinity, maxP = -Infinity;
      for (const it of list) {
        const p = Number(it.p || it.price || 0);
        if (!isNaN(p)) { if (p < minP) minP = p; if (p > maxP) maxP = p; }
      }
      if (!isFinite(minP) || !isFinite(maxP)) return null;
      return { minP, maxP };
    } catch (_) {
      return null;
    }
  }

  function populateChainOptions(tokens) {
    const options = dedupeChains(tokens);
    chainFilter.innerHTML = '<option value="">全部链</option>' + options.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  }

  function handleHeaderSortClick(e) {
    const th = e.target.closest('th');
    if (!th) return;
    const key = th.getAttribute('data-key');
    if (!key) return;
    if (sortKey !== key) {
      sortKey = key;
      sortDir = 'desc';
    } else {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    }
    applySort();
    renderPage();
  }

  // Events
  searchInput.addEventListener('input', debounce(applyFilters, 200));
  chainFilter.addEventListener('change', applyFilters);
  cexFilter.addEventListener('change', applyFilters);
  pageSizeSel.addEventListener('change', () => { pageIndex = 0; renderPage(); });
  prevBtn.addEventListener('click', () => { if (pageIndex > 0) { pageIndex -= 1; renderPage(); }});
  nextBtn.addEventListener('click', () => { pageIndex += 1; renderPage(); });
  table.querySelector('thead').addEventListener('click', handleHeaderSortClick);
  const monitorBtn = document.getElementById('monitorBtn');
  monitorBtn.addEventListener('click', () => {
    if (monitoringActive) {
      stopMonitoring();
    } else {
      startMonitoringSelected();
    }
  });
  onlyNewChk.addEventListener('change', applyFilters);
  onlyNewChk.addEventListener('change', () => {
    document.body.classList.toggle('only-new-on', onlyNewChk.checked);
  });

  function debounce(fn, wait) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  // Kickoff
  // 初始化：根据默认是否勾选，仅显示 NEW 并加粗符号
  document.body.classList.toggle('only-new-on', onlyNewChk.checked);
  fetchTokens();

  function getSelectedTokensOnPage() {
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const selected = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const chk = row.querySelector('input[type="checkbox"]');
      if (chk && chk.checked) {
        const idx = pageIndex * Number(pageSizeSel.value) + i;
        if (filteredTokens[idx]) selected.push(filteredTokens[idx]);
      }
    }
    return selected;
  }

  function startMonitoringSelected() {
    const tokens = getSelectedTokensOnPage();
    if (tokens.length === 0) return;
    monitoringActive = true;
    monitorBtn.textContent = '关闭监控';
    for (const t of tokens) {
      // 找到该 token 的单元格
      const rows = Array.from(tbody.querySelectorAll('tr'));
      for (const row of rows) {
        const symText = row.querySelector('.symbol-cell strong')?.textContent?.trim();
        if (symText === t.symbol) {
          const cell = row.children[7]; // 列顺序：选,符号,链,价格,24h%,成交额,市值,监控,... -> 监控列索引为 7
          if (cell) monitorStability(t, cell);
          break;
        }
      }
    }
  }

  function stopMonitoring() {
    monitoringActive = false;
    monitorBtn.textContent = '开始监控';
    // 停止所有 watcher
    for (const [sym, w] of stabilityWatchers.entries()) {
      if (w) w.running = false;
      stabilityWatchers.delete(sym);
    }
    // 将监控列恢复为“停止监控”
    for (const row of Array.from(tbody.querySelectorAll('tr'))) {
      const cell = row.children[7];
      if (cell) { cell.textContent = '停止监控'; cell.className = 'numeric stability-paused'; }
    }
  }
})();


