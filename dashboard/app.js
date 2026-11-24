// Token Radar's dashboard, rewritten for the radar-2 entry.
//
// It reads window.RADAR (written beside dashboard/ by main.ts) and renders the
// ranked board, a filterable table, a per-protocol detail drawer with the model's
// own inputs and the protocol's farm plan, a compare tray and a CSV export.
// No network: every byte it shows is in data.js. The farm plan and the implied
// value are the same derivation main.ts writes to board.json, so the page and
// the board are visibly the same arithmetic.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var root = document.getElementById('board');
  var state = {
    q: '',
    category: 'all',
    tab: 'pre-token',
    sort: 'implied',
    dir: -1,
    selected: null,
    compare: []
  };
  var MAX_COMPARE = 3;

  // ---------- small formatting helpers ----------

  var compactUsd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return compactUsd.format(n);
  }

  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  function ageLabel(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function chainLabel(p) {
    if (!p.chains || p.chains.length === 0) return 'an unnamed chain';
    return p.chains.slice(0, 2).join(', ');
  }

  // ---------- the model, as the page recomputes it ----------

  // The same function lib/model.ts runs: TVL times the category ratio, times the
  // growth multiplier, times the maturity multiplier. The page recomputes each
  // row from the snapshot figures and checks the number board.json carries.
  function impliedOf(row, model) {
    var change = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    var growth = Math.min(model.growth_cap, Math.max(model.growth_floor, change));
    var growthMult = 1 + (growth / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    return Math.max(1, Math.round(row.tvl_usd * (row.category_ratio || 0) * growthMult * maturity));
  }

  // ---------- the farm plan, as board.json carries it ----------

  // One action per category family. The wording is the plan's own: category,
  // chains, TVL and age decide the action, the capital and the hold. No name
  // is special-cased, and the strings are the same ones lib/model.ts writes.
  var ACTION_RULES = [
    { test: /lend|cdp|collateral/i, text: function (p, capital, chain) { return 'Supply $' + capital + ' of USDC to ' + p.name + ' on ' + chain + ' and keep the position open.'; } },
    { test: /dex|yield|leveraged farm/i, text: function (p, capital, chain) { return 'Provide $' + capital + ' of liquidity to ' + p.name + "'s main pool on " + chain + ' and keep the position open.'; } },
    { test: /bridge/i, text: function (p, capital, chain) { return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + p.name + ' and use the bridged funds in its app.'; } },
    { test: /staking|restak/i, text: function (p, capital) { return 'Stake $' + capital + " of the chain's staking asset through " + p.name + ' and keep the receipt.'; } },
    { test: /perpetual|derivative/i, text: function (p, capital) { return 'Deposit $' + capital + ' of USDC as margin on ' + p.name + ' and open one small hedge.'; } },
    { test: /prediction/i, text: function (p, capital) { return 'Fund $' + capital + ' and place one market position on ' + p.name + '.'; } },
    { test: /curator|allocator/i, text: function (p, capital, chain) { return 'Deposit $' + capital + ' into a ' + p.name + ' vault on ' + chain + ' and keep the shares.'; } },
    { test: /stable/i, text: function (p, capital, chain) { return 'Mint or deposit $' + capital + ' of the stable asset through ' + p.name + ' on ' + chain + '.'; } },
    { test: /rwa/i, text: function (p, capital, chain) { return 'Mint $' + capital + " of the protocol's yield asset on " + chain + ' and hold it.'; } },
    { test: /insurance/i, text: function (p, capital, chain) { return 'Buy $' + capital + ' of cover from ' + p.name + ' on ' + chain + ' and keep the policy.'; } }
  ];

  function actionFor(p, capital, chain) {
    var c = p.category || '';
    for (var i = 0; i < ACTION_RULES.length; i++) {
      if (ACTION_RULES[i].test.test(c)) return ACTION_RULES[i].text(p, capital, chain);
    }
    return 'Deposit $' + capital + ' of USDC into ' + p.name + ' on ' + chain + ' and keep the position open.';
  }

  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }

  function holdDaysFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }

  function stepText(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }

  function farmSteps(p) {
    var chain = p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain';
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var secondChain = p.chains && p.chains.length > 1 ? p.chains[1] : null;
    var weekly = secondChain === null
      ? 'Make one qualifying action each week on ' + chain + ', such as a deposit, a borrow, a swap or a vote.'
      : 'Make one qualifying action each week on ' + chain + ', such as a deposit, a borrow, a swap or a vote, then repeat it on ' + secondChain + '.';
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital and about $' + (capital >= 150 ? 8 : 4) + ' of gas', time: '15 minutes to set up' },
      { text: weekly, cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepText);
  }

  // ---------- the address bar carries the view ----------

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
  }

  function writeHash() {
    var params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.selected) params.set('p', state.selected);
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  // ---------- the rows under the current filter and sort ----------

  function visibleRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (!q) return true;
      var hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function sortValue(r, key) {
    if (key === 'name') return r.name.toLowerCase();
    if (key === 'tvl') return r.tvl_usd;
    if (key === 'growth') return r.change_7d === null ? -Infinity : r.change_7d;
    if (key === 'age') return r.age_days === null ? Infinity : r.age_days;
    return r.implied_value_usd;
  }

  function sortedRows(list) {
    var key = state.sort;
    var dir = state.dir;
    return list.slice().sort(function (a, b) {
      var av = sortValue(a, key);
      var bv = sortValue(b, key);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function categories() {
    var seen = {};
    DATA.rows.forEach(function (r) { seen[r.category || 'Other'] = true; });
    return Object.keys(seen).sort();
  }

  function movers() {
    return DATA.rows
      .filter(function (r) { return r.change_7d !== null && r.change_7d !== undefined; })
      .slice()
      .sort(function (a, b) { return b.change_7d - a.change_7d; })
      .slice(0, 5);
  }

  function findRow(slug) {
    for (var i = 0; i < DATA.rows.length; i++) if (DATA.rows[i].slug === slug) return DATA.rows[i];
    return null;
  }

  // ---------- pieces of the page ----------

  function mastheadHTML() {
    return '<header class="masthead">' +
      '<div class="brand"><span class="dot" aria-hidden="true"></span><span class="name">Token Radar</span></div>' +
      '<div class="stamp"><span>Snapshot ' + esc(DATA.as_of) + '</span><span>DefiLlama protocol index</span><span>' + esc(DATA.model_version) + ' model</span></div>' +
      '</header>';
  }

  function ledeHTML() {
    return '<section class="lede"><div>' +
      '<h1>' + DATA.watchlist_size + ' watchlist protocols, ranked by implied value</h1>' +
      '<p class="standfirst">The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor. Implied value is a model, not a promise.</p>' +
      '</div><div class="scorecard">' +
      '<div><span class="label">Watchlist covered</span><span class="value">' + DATA.watchlist_size + ' / ' + DATA.watchlist_size + '</span></div>' +
      '<div><span class="label">Pre-token rows scored</span><span class="value">' + DATA.board_size + '</span></div>' +
      '<div><span class="label">Early rows below the floor</span><span class="value">' + DATA.early_size + '</span></div>' +
      '<div><span class="label">Live-token protocols set aside</span><span class="value">' + DATA.live_size + '</span></div>' +
      '</div></section>';
  }

  function moversHTML() {
    var top = movers();
    if (top.length === 0) return '';
    var items = top.map(function (r) {
      return '<li><span class="mover-name">' + esc(r.name) + '</span>' +
        '<span class="mover-num">' + pct(r.change_7d) + ' in 7 days &middot; ' + money(r.implied_value_usd) + ' implied</span></li>';
    }).join('');
    return '<section class="movers" aria-label="Fastest growing pre-token protocols"><h2>Fastest growing this week</h2>' +
      '<p>The five pre-token rows with the strongest seven-day TVL growth. Growth lifts implied value, it does not guarantee a launch.</p>' +
      '<ol>' + items + '</ol></section>';
  }

  function toolbarHTML() {
    var cats = categories();
    var options = '<option value="all">All categories</option>' + cats.map(function (c) {
      return '<option value="' + esc(c) + '"' + (c === state.category ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');
    var count = state.tab === 'pre-token' ? visibleRows().length + ' rows shown' : DATA.live.length + ' live-token protocols';
    return '<div class="toolbar">' +
      '<div class="field"><label for="q">Search</label><input type="search" id="q" placeholder="Search name, category or chain" value="' + esc(state.q) + '" aria-label="Search the board"></div>' +
      '<div class="field"><label for="category">Category</label><select id="category" aria-label="Filter by category">' + options + '</select></div>' +
      '<div class="field"><span class="field-label">Token status</span><div class="segmented" role="group" aria-label="Token status">' +
      '<button type="button" data-action="tab" data-tab="pre-token" aria-pressed="' + (state.tab === 'pre-token') + '">Pre-token</button>' +
      '<button type="button" data-action="tab" data-tab="live" aria-pressed="' + (state.tab === 'live') + '">Live token</button>' +
      '</div></div>' +
      '<button type="button" class="btn" data-action="csv">Download CSV</button>' +
      '<span class="rowcount">' + esc(count) + '</span>' +
      '</div>';
  }

  function sortButton(key, label) {
    var arrow = state.sort === key ? (state.dir < 0 ? ' &darr;' : ' &uarr;') : '';
    return '<button type="button" data-action="sort" data-key="' + key + '">' + label + arrow + '</button>';
  }

  function originPill(row) {
    if (row.watchlist) return '<span class="pill watch">Watchlist</span>';
    return '<span class="pill early">Early</span>';
  }

  function boardHTML() {
    var list = sortedRows(visibleRows());
    if (list.length === 0) {
      return '<div class="card"><div class="empty"><h2>No protocol matches that filter</h2>' +
        '<p>Clear the search or pick another category to see the board again.</p>' +
        '<button type="button" class="btn primary" data-action="clear-filters">Clear filters</button></div></div>';
    }
    var max = list[0].implied_value_usd || 1;
    var body = list.map(function (r) {
      var growth = r.change_7d === null ? 'n/a' : pct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down';
      var checked = state.compare.indexOf(r.slug) >= 0 ? ' checked' : '';
      var width = Math.max(3, Math.round((r.implied_value_usd / max) * 100));
      return '<tr data-selected="' + (state.selected === r.slug) + '" tabindex="0" data-action="open" data-slug="' + esc(r.slug) + '">' +
        '<td><input type="checkbox" class="compare-check" data-compare="' + esc(r.slug) + '"' + checked + ' aria-label="Compare ' + esc(r.name) + '"></td>' +
        '<td class="num">' + r.rank + '</td>' +
        '<td><div class="cell-name"><b>' + esc(r.name) + '</b><span class="muted">' + esc(r.category || 'Other') + ' on ' + esc(chainLabel(r)) + '</span></div></td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num ' + growthClass + '">' + growth + '</td>' +
        '<td class="num">' + ageLabel(r.age_days) + '</td>' +
        '<td><div class="value-bar"><span class="track" aria-hidden="true"><i style="width:' + width + '%"></i></span><span class="num">' + money(r.implied_value_usd) + '</span></div></td>' +
        '<td>' + originPill(r) + '</td>' +
        '</tr>';
    }).join('');
    return '<div class="card"><div class="scroller"><table>' +
      '<caption>Pre-token protocols, strongest implied value first. Select a row for its model and farm plan; tick up to three rows to compare them.</caption>' +
      '<thead><tr><th scope="col">Compare</th><th scope="col">' + sortButton('implied', 'Rank') + '</th><th scope="col">' + sortButton('name', 'Protocol') + '</th>' +
      '<th scope="col">' + sortButton('tvl', 'TVL') + '</th><th scope="col">' + sortButton('growth', '7d') + '</th>' +
      '<th scope="col">' + sortButton('age', 'Age') + '</th><th scope="col">' + sortButton('implied', 'Implied value') + '</th>' +
      '<th scope="col">Origin</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table></div></div>';
  }

  function liveHTML() {
    var body = DATA.live.map(function (r) {
      return '<tr>' +
        '<td class="num">live</td>' +
        '<td><div class="cell-name"><b>' + esc(r.name) + '</b><span class="muted">' + esc(r.category || 'Other') + ' on ' + esc(chainLabel(r)) + '</span></div></td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'up' : 'down') + '">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + money(r.mcap_usd) + '</td>' +
        '<td><span class="pill live">already trades</span></td>' +
        '</tr>';
    }).join('');
    return '<div class="card"><div class="scroller"><table>' +
      '<caption>Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.</caption>' +
      '<thead><tr><th scope="col">Status</th><th scope="col">Protocol</th><th scope="col">TVL</th><th scope="col">7d</th><th scope="col">Market cap</th><th scope="col">Token</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table></div></div>';
  }

  function methodHTML() {
    var m = DATA.model;
    var ratios = Object.keys(DATA.category_ratios || {}).map(function (c) {
      return { category: c, ratio: DATA.category_ratios[c].ratio, comps: DATA.category_ratios[c].comps };
    }).sort(function (a, b) { return b.comps - a.comps; }).slice(0, 12);
    var ratioBody = ratios.map(function (r) {
      return '<tr><td>' + esc(r.category) + '</td><td class="num">' + r.ratio.toFixed(3) + 'x</td><td class="num">' + r.comps + '</td></tr>';
    }).join('');
    return '<section class="card method"><h2>How implied value is computed</h2>' +
      '<p>Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.</p>' +
      '<div class="formula">implied = round( tvl_usd &times; category ratio &times; (1 + clamp(change_7d, ' + m.growth_floor + ', ' + m.growth_cap + ') / 100 &times; ' + m.growth_weight + ') &times; (' + m.maturity_floor + ' + min(age_days, ' + m.maturity_days + ') / ' + m.maturity_days + ' &times; ' + m.maturity_range + ') )</div>' +
      '<p>The category ratio is the median market-cap / TVL of the live-token protocols in the same category, priced by the market itself: a lender is valued off live lenders, a DEX off live DEXes. A category with fewer than ' + m.min_category_comps + ' live protocols, or none at all, uses the global median of ' + DATA.global_ratio.toFixed(3) + 'x. Ratios are clamped to ' + m.ratio_min + 'x&ndash;' + m.ratio_max + 'x.</p>' +
      '<div class="scroller"><table>' +
      '<caption>Category ratios from the snapshot: the 12 biggest categories by live comparables.</caption>' +
      '<thead><tr><th scope="col">Category</th><th scope="col">Median mcap / TVL</th><th scope="col">Live comps</th></tr></thead>' +
      '<tbody>' + ratioBody + '</tbody></table></div>' +
      '<p>TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' + m.unknown_age_days + ' days. The early radar is every pre-token protocol below the watchlist floor, and the live-token protocols are set aside with their market caps shown.</p>' +
      '</section>';
  }

  function trayHTML() {
    if (state.compare.length === 0) return '';
    var cols = state.compare.map(function (slug) {
      var r = findRow(slug);
      if (!r) return '';
      return '<div class="compare-col"><span class="c-name">' + esc(r.name) + '</span>' +
        '<span class="c-num">Rank ' + r.rank + ' &middot; ' + money(r.implied_value_usd) + ' implied</span>' +
        '<span class="c-num">TVL ' + money(r.tvl_usd) + ' &middot; ' + pct(r.change_7d) + ' in 7d</span>' +
        '<span class="c-num">Ratio ' + r.category_ratio.toFixed(3) + 'x &middot; age ' + ageLabel(r.age_days) + '</span></div>';
    }).join('');
    return '<section class="compare-tray" aria-label="Comparison"><div class="row"><h2>Comparing ' + state.compare.length + ' of 3</h2>' +
      '<button type="button" class="btn" data-action="clear-compare">Clear comparison</button></div>' +
      '<div class="compare-grid">' + cols + '</div></section>';
  }

  // ---------- the detail drawer ----------

  var dialog = document.createElement('dialog');
  dialog.className = 'drawer';
  dialog.id = 'detail';
  dialog.setAttribute('aria-labelledby', 'detail-title');
  dialog.addEventListener('close', function () {
    state.selected = null;
    writeHash();
  });

  function openDetail(slug) {
    var row = findRow(slug);
    if (!row) return;
    state.selected = slug;
    writeHash();
    var recomputed = impliedOf(row, DATA.model);
    var matchNote = recomputed === row.implied_value_usd
      ? 'the same number board.json carries.'
      : 'which differs from the board: the data would be stale.';
    var steps = farmSteps(row).map(function (s) {
      var at = s.indexOf(' Cost: ');
      var action = at >= 0 ? s.slice(0, at) : s;
      var tail = at >= 0 ? s.slice(at + 1) : '';
      return '<li><b>' + esc(action) + '</b><span class="cost">' + esc(tail) + '</span></li>';
    }).join('');
    dialog.innerHTML =
      '<div class="drawer-head"><div>' +
      '<span class="kicker-line">Rank ' + row.rank + ' of ' + DATA.board_size + ' &middot; ' + (row.watchlist ? 'watchlist' : 'early radar') + '</span>' +
      '<h2 id="detail-title">' + esc(row.name) + '</h2>' +
      '<p class="lede-line">' + esc(row.category || 'Other') + ' on ' + esc((row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain')) + '</p>' +
      '</div><button type="button" class="drawer-close" data-action="close-detail" aria-label="Close details">Close</button></div>' +
      '<section class="drawer-section"><h3>Implied value</h3><div class="ledger">' +
      '<div><span>TVL</span><b>' + money(row.tvl_usd) + '</b></div>' +
      '<div><span>Seven-day growth</span><b>' + pct(row.change_7d) + '</b></div>' +
      '<div><span>Age with no token</span><b>' + ageLabel(row.age_days) + '</b></div>' +
      '<div><span>Category ratio</span><b>' + row.category_ratio.toFixed(3) + 'x</b></div>' +
      '<div><span>Live comps</span><b>' + (row.category_comps > 0 ? row.category_comps + ' live ' + esc(row.category || 'protocols') : 'global median') + '</b></div>' +
      '<div><span>Growth multiplier</span><b>' + row.growth_multiplier + '</b></div>' +
      '<div><span>Maturity multiplier</span><b>' + row.maturity_multiplier + '</b></div>' +
      '<div><span>Implied value</span><b>' + money(row.implied_value_usd) + '</b></div>' +
      '</div><p class="note" style="margin-top:12px">Model ' + esc(DATA.model_version) + ': the same function scores every protocol. The page recomputes this row as ' + money(recomputed) + ', ' + matchNote + ' This is an estimate, not a price.</p></section>' +
      '<section class="drawer-section"><h3>Farm plan</h3><ol class="plan">' + steps + '</ol></section>';
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  // ---------- CSV export ----------

  function csvCell(value) {
    var s = value === null || value === undefined ? '' : String(value);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function downloadCSV() {
    var list = sortedRows(visibleRows());
    var head = ['rank', 'name', 'category', 'chains', 'tvl_usd', 'change_7d', 'age_days', 'implied_value_usd', 'category_ratio', 'origin'];
    var lines = [head.join(',')];
    list.forEach(function (r) {
      lines.push([
        r.rank, r.name, r.category || '', (r.chains || []).join(';'), r.tvl_usd,
        r.change_7d === null ? '' : r.change_7d, r.age_days === null ? '' : r.age_days,
        r.implied_value_usd, r.category_ratio, r.watchlist ? 'watchlist' : 'early'
      ].map(csvCell).join(','));
    });
    var blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'token-radar-board.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  // ---------- render and events ----------

  function render() {
    var html = '<div class="shell">' + mastheadHTML() + ledeHTML();
    if (state.tab === 'pre-token') html += moversHTML();
    html += toolbarHTML();
    html += state.tab === 'pre-token' ? boardHTML() : liveHTML();
    if (state.tab === 'pre-token') html += methodHTML();
    html += trayHTML();
    html += '</div>';
    root.innerHTML = html;
    root.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) root.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  function toggleCompare(slug, checked) {
    var at = state.compare.indexOf(slug);
    if (checked && at < 0) {
      if (state.compare.length >= MAX_COMPARE) return false;
      state.compare.push(slug);
    } else if (!checked && at >= 0) {
      state.compare.splice(at, 1);
    }
    return true;
  }

  root.addEventListener('click', function (e) {
    var target = e.target;
    while (target && target !== root && !target.getAttribute('data-action')) target = target.parentElement;
    if (!target || target === root) return;
    var action = target.getAttribute('data-action');
    if (action === 'sort') {
      var key = target.getAttribute('data-key');
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = -1; }
      render();
    } else if (action === 'tab') {
      state.tab = target.getAttribute('data-tab');
      render();
    } else if (action === 'csv') {
      downloadCSV();
    } else if (action === 'clear-filters') {
      state.q = '';
      state.category = 'all';
      writeHash();
      render();
    } else if (action === 'clear-compare') {
      state.compare = [];
      render();
    } else if (action === 'close-detail') {
      dialog.close();
    } else if (action === 'open') {
      openDetail(target.getAttribute('data-slug'));
    }
  });

  root.addEventListener('input', function (e) {
    if (e.target.id === 'q') {
      state.q = e.target.value;
      writeHash();
      render();
      var q = document.getElementById('q');
      if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    }
  });

  root.addEventListener('change', function (e) {
    if (e.target.id === 'category') {
      state.category = e.target.value;
      writeHash();
      render();
    } else if (e.target.getAttribute('data-compare')) {
      var slug = e.target.getAttribute('data-compare');
      if (!toggleCompare(slug, e.target.checked)) e.target.checked = false;
      else render();
    }
  });

  root.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.getAttribute && e.target.getAttribute('data-action') === 'open') {
      e.preventDefault();
      openDetail(e.target.getAttribute('data-slug'));
    }
  });

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });

  readHash();
  render();
})();
