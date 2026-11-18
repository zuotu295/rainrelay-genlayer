<script>
  import { onMount } from 'svelte';
  import { address, calldataAddress, connect, explorer, read, transaction, validAddress } from './chain.js';

  const labels = { PROPOSED: 'Awaiting acceptance', ACCEPTED: 'Accepted', CREDIT_DUE: 'Credit due', BELOW_TRIGGER: 'Below trigger', REDEEMED: 'Redeemed' };
  const finalStates = new Set(['Finalized', 'Failed', 'Canceled']);
  const actions = { propose: 'Propose agreement', accept: 'Accept terms', settle: 'Settle rainfall', acknowledge_redemption: 'Acknowledge redemption' };
  const storage = 'rainrelay:' + address;
  const queryId = Number(new URLSearchParams(location.search).get('agreement'));
  const dateAt = (date, offset = 0) => new Date(Date.parse(date + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10);
  const today = () => new Date().toISOString().slice(0, 10);
  const tomorrow = () => dateAt(today(), 1);
  const short = (value) => value ? value.slice(0, 6) + '…' + value.slice(-4) : '—';
  const mm = (value) => (value / 10).toFixed(1);
  const niceDate = (date) => new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(date + 'T00:00:00Z'));
  const statusFor = (row, date) => row.status === 'PROPOSED' && date >= row.start ? 'Offer expired' : labels[row.status];

  let records = $state([]);
  let item = $state(null);
  let wallet = $state('');
  let dayNow = $state(today());
  let busy = $state(false);
  let refreshing = $state(false);
  let problem = $state('');
  let activity = $state([]);
  let listMode = $state('All');
  let cursors = $state([0]);
  let loading = $state(true);
  let loaded = $state(false);
  let drawer = $state(null);
  let notice = $state('');
  let receipt = $state('');
  let viewIndex = 0;
  let requestIndex = 0;
  let actionRunning = false;
  let form = $state({ title: '', guest: '', lat: 51.5, lon: -0.12, start: tomorrow(), end: tomorrow(), threshold: 10, credits: 20 });
  let cutoff = $derived(item ? dateAt(item.end, 8) : '');
  let audience = $derived(item?.replay ? 'Historical replay' : 'Live agreement');
  let owned = $derived(wallet && wallet.toLowerCase() === item?.sponsor?.toLowerCase());
  let guest = $derived(wallet && wallet.toLowerCase() === item?.guest?.toLowerCase());
  let showRecords = $derived(records.filter((row) => listMode === 'All' || (listMode === 'Replay' ? row.replay : !row.replay)));
  let peak = $derived(Math.max(1, ...(item?.daily || [])));
  let pending = $derived(activity.some((entry) => !finalStates.has(entry.state)));
  let itemPending = $derived(item && activity.some((entry) => entry.id === item.id && !finalStates.has(entry.state)));

  function detail(error) {
    return error?.code === 4001 ? 'Wallet request declined.' : String(error?.shortMessage || error?.message || error || 'Request failed.').slice(0, 230);
  }

  async function choose(id) {
    const request = ++viewIndex;
    item = null;
    receipt = '';
    const url = new URL(location.href);
    url.searchParams.set('agreement', id);
    history.replaceState(null, '', url);
    try {
      const data = await read('get_agreement', [id]);
      if (request === viewIndex) {
        item = data && { ...data, id };
        if (!data) problem = 'Agreement not found.';
      }
    } catch (error) {
      if (request === viewIndex) problem = detail(error);
    }
  }

  async function load(selectDefault = false) {
    const request = ++requestIndex;
    loading = true;
    try {
      const result = await read('list_agreements', [cursors.at(-1)]);
      if (request !== requestIndex) return;
      records = result || [];
      loaded = true;
      if (selectDefault && !item) {
        const id = Number.isSafeInteger(queryId) && queryId > 0 ? queryId : records.find((row) => row.id === 1)?.id ?? records[0]?.id;
        if (id) await choose(id);
      } else if (item) {
        const selected = item.id;
        const updated = records.find((row) => row.id === selected);
        const detailRecord = updated || await read('get_agreement', [selected]);
        if (item?.id === selected && request === requestIndex && detailRecord) item = { ...detailRecord, id: selected };
      }
    } catch (error) {
      if (request === requestIndex) problem = detail(error);
    } finally {
      if (request === requestIndex) loading = false;
    }
  }

  function persist() {
    try { localStorage.setItem(storage, JSON.stringify(activity)); } catch { /* Current session still tracks the transaction. */ }
  }

  async function check() {
    if (refreshing) return;
    dayNow = today();
    if (!pending) return;
    refreshing = true;
    let changed = false;
    try {
      const updates = await Promise.all(activity.filter((entry) => !finalStates.has(entry.state)).map(async (entry) => {
        try {
          const status = await transaction(entry.hash, entry.method);
          changed ||= status.state === 'Finalized';
          return [entry.hash, status];
        } catch (error) {
          return [entry.hash, { detail: 'Tracking will retry. ' + detail(error) }];
        }
      }));
      const lookup = new Map(updates);
      activity = activity.map((entry) => ({ ...entry, ...lookup.get(entry.hash) }));
      persist();
      if (changed) await load();
    } finally {
      refreshing = false;
    }
  }

  onMount(() => {
    try {
      const cached = JSON.parse(localStorage.getItem(storage) || '[]');
      if (Array.isArray(cached)) activity = cached;
    } catch { activity = []; }
    const updateWallet = ([account]) => wallet = account || '';
    window.ethereum?.on?.('accountsChanged', updateWallet);
    void load(true);
    void check();
    const pulse = setInterval(check, 8000);
    return () => {
      clearInterval(pulse);
      window.ethereum?.removeListener?.('accountsChanged', updateWallet);
    };
  });

  async function walletConnect() {
    busy = true;
    problem = '';
    try {
      wallet = (await connect()).account;
    } catch (error) {
      problem = detail(error);
    } finally {
      busy = false;
    }
  }

  async function write(method, args, id) {
    if (actionRunning) return false;
    actionRunning = true;
    busy = true;
    problem = '';
    notice = 'Approve the transaction in your wallet.';
    try {
      const { client, account } = await connect();
      wallet = account;
      const hash = await client.writeContract({ address, functionName: method, args, value: 0n, leaderOnly: false });
      activity = [{ hash, method, id, state: 'Submitted', detail: 'Waiting for validators' }, ...activity];
      persist();
      notice = 'Submitted to Studionet. Track its status in Activity.';
      void check();
      return true;
    } catch (error) {
      problem = detail(error);
      notice = '';
      return false;
    } finally {
      actionRunning = false;
      busy = false;
    }
  }

  async function propose(event) {
    event.preventDefault();
    if (!validAddress.test(form.guest) || /^0x0{40}$/i.test(form.guest)) {
      problem = 'Enter a valid nonzero customer wallet address.';
      return;
    }
    const args = [
      form.title, calldataAddress(form.guest), Math.round(form.lat * 100), Math.round(form.lon * 100),
      form.start, form.end, Math.round(form.threshold * 10), form.credits,
    ];
    if (await write('propose', args)) drawer.close();
  }

  async function share() {
    try {
      await navigator.clipboard.writeText(location.href);
      notice = 'Agreement link copied.';
    } catch {
      notice = location.href;
    }
  }
</script>

<header class="topbar">
  <a class="logo" href="./" aria-label="RainRelay home"><span class="glyph" aria-hidden="true"><i></i><i></i><i></i></span> RainRelay</a>
  <span class="desk-label">WEATHER AGREEMENT DESK</span>
  <div class="top-actions"><a href="#activity" class="activity-link">Activity {#if pending}<span class="pulse" aria-label="Pending transactions"></span>{/if}</a><button class="wallet" onclick={walletConnect} disabled={busy}>{wallet ? short(wallet) : 'Connect wallet'}</button></div>
</header>

<main class="layout">
  <aside class="rail">
    <div class="rail-head">
      <div class="rail-heading"><h1>Agreements</h1><button class="new" onclick={() => { problem = ''; drawer.showModal(); }} aria-label="New agreement">+ New</button></div>
      <div class="filters" aria-label="Agreement filter">
        {#each ['All', 'Live', 'Replay'] as filter}
          <button class:chosen={listMode === filter} aria-pressed={listMode === filter} onclick={() => listMode = filter}>{filter}</button>
        {/each}
      </div>
    </div>
    <div class="list">
      {#each showRecords as row (row.id)}
        <button class="row" class:selected={item?.id === row.id} onclick={() => { problem = ''; void choose(row.id); }}>
          <span class="row-num"><span>RR/{String(row.id).padStart(3, '0')}</span><span>{row.replay ? 'REPLAY' : 'LIVE'}</span></span>
          <strong>{row.title}</strong>
          <span class="row-state"><span class="dot {row.status.toLowerCase()}"></span>{statusFor(row, dayNow)}<span class="row-date">{niceDate(row.start)}</span></span>
        </button>
      {:else}
        <p class="rail-empty">{loading ? 'Reading finalized agreements…' : loaded ? 'No agreements on this page match the filter.' : 'Agreement list unavailable.'}</p>
      {/each}
    </div>
    <div class="pagination">
      <button disabled={cursors.length < 2 || loading} onclick={() => { cursors = cursors.slice(0, -1); void load(); }}>← Newer</button>
      <button disabled={!records.length || records.at(-1).id <= 1 || loading} onclick={() => { cursors = [...cursors, records.at(-1).id]; void load(); }}>Older →</button>
    </div>
    <div class="chain-label"><span class="pulse"></span> GENLAYER STUDIONET <span>61999</span></div>
  </aside>

  <div class="main-pane">
    <div class="notices" aria-live="polite">
      {#if problem}<p class="error">{problem}</p>{/if}
      {#if notice}<p>{notice}</p>{/if}
    </div>
    {#if item}
      <section class="case">
        <div class="case-meta"><span>RR/{String(item.id).padStart(3, '0')} / {audience}</span><button class="text-btn" onclick={share}>Copy agreement link ↗</button></div>
        <h2>{item.title}</h2>
        <div class="case-bottom"><span>{niceDate(item.start)}{#if item.end !== item.start} – {niceDate(item.end)}{/if} {item.start.slice(0, 4)} · UTC</span><span class="state"><span class="dot {item.status.toLowerCase()}"></span>{statusFor(item, dayNow)}</span></div>
      </section>

      <div class="metrics">
        <div><span>RAIN TRIGGER</span><strong>{mm(item.threshold)} <small>mm</small></strong></div>
        <div><span>ARCHIVE TOTAL</span><strong>{item.total === null ? '—' : mm(item.total)} <small>mm</small></strong></div>
        <div><span>BOOKING CREDIT</span><strong>{item.credits} <small>units</small></strong></div>
      </div>

      <section class="analysis">
        <div class="rain-panel">
          <div class="section-head"><h3>Daily precipitation</h3><a href="https://open-meteo.com/en/docs/historical-weather-api" target="_blank" rel="noreferrer">ERA5 ↗</a></div>
          {#if item.daily.length}
            <div class="graph" aria-label="Finalized daily precipitation totals">
              {#each item.daily as value, index}
                <div class="column"><div class="bar-space"><div class="bar" style:--height={Math.max(2, 79 * value / peak) + '%'}><span>{mm(value)}</span></div></div><span>{niceDate(dateAt(item.start, index))}</span></div>
              {/each}
            </div>
            <div class="comparison">
              <span>{item.total >= item.threshold ? 'Trigger met' : 'Trigger not met'}</span>
              <div class="track"><i style:--fill={Math.min(100, item.total / item.threshold * 100) + '%'}></i></div>
              <span>{mm(item.total)} / {mm(item.threshold)} mm</span>
            </div>
          {:else}
            <div class="chart-empty"><span class="rain-symbol" aria-hidden="true">╱ ╱ ╱</span><p>Daily values appear after settlement finalizes.</p></div>
          {/if}
          <p class="chart-foot">{(item.lat / 100).toFixed(2)}°, {(item.lon / 100).toFixed(2)}° · Total precipitation · UTC</p>
        </div>
        <div class="timeline-panel">
          <div class="section-head"><h3>Agreement flow</h3></div>
          <ol class="timeline">
            <li class="done"><strong>Terms locked</strong><span>{item.replay ? 'Historical example' : 'Sponsor ' + short(item.sponsor)}</span></li>
            <li class:done={item.status !== 'PROPOSED'}><strong>Customer acceptance</strong><span>{item.replay ? 'Pre-accepted replay' : short(item.guest) + ' · before ' + item.start}</span></li>
            <li class:done={item.total !== null}><strong>Archive settlement</strong><span>Eligible on {cutoff} UTC</span></li>
            {#if item.status === 'CREDIT_DUE' || item.status === 'REDEEMED'}
              <li class:done={item.status === 'REDEEMED'}><strong>Redemption</strong><span>{item.replay ? 'Replay only' : item.order || 'Sponsor acknowledgment pending'}</span></li>
            {/if}
          </ol>
          {#if item.status === 'PROPOSED' && dayNow < item.start}
            <button class="primary" disabled={busy || itemPending || (!!wallet && !guest)} onclick={() => write('accept', [item.id], item.id)}>Accept terms</button>
            {#if wallet && !guest}<p class="chart-foot">Switch to the named customer wallet to accept.</p>{/if}
          {:else if item.status === 'ACCEPTED'}
            <button class="primary" disabled={busy || itemPending || dayNow < cutoff} onclick={() => write('settle', [item.id], item.id)}>Settle rainfall</button>
          {:else if item.status === 'CREDIT_DUE' && !item.replay && (owned || !wallet)}
            <form class="redeem" onsubmit={(event) => { event.preventDefault(); void write('acknowledge_redemption', [item.id, receipt], item.id); }}>
              <label for="order">Public booking reference</label><input id="order" bind:value={receipt} pattern={'[A-Za-z0-9_\\-]{4,48}'} required maxlength="48" placeholder="BOOKING-025">
              <button class="primary" disabled={busy || itemPending}>Acknowledge redemption</button>
            </form>
          {/if}
        </div>
      </section>
    {:else}
      <section class="case blank"><h2>Booking weather desk</h2><p>Select an agreement to inspect its locked terms and rainfall settlement.</p></section>
    {/if}

    <section class="activity" id="activity">
      <div class="section-head"><h3>Transaction activity</h3><button class="text-btn" disabled={refreshing} onclick={() => { void check(); void load(); }}>Refresh ↻</button></div>
      {#each activity as entry (entry.hash)}
        <div class="tx"><span class="tx-phase">{entry.state}</span>{#if entry.id}<button class="text-btn tx-case" onclick={() => choose(entry.id)}>{actions[entry.method]} · #{entry.id}</button>{:else}<strong>{actions[entry.method]}</strong>{/if}<span>{entry.detail}</span><a href={explorer + entry.hash} target="_blank" rel="noreferrer">Explorer ↗</a></div>
      {:else}
        <p>Transactions submitted from this browser will appear here.</p>
      {/each}
    </section>
  </div>
</main>
<footer>RainRelay <span>Weather observations by Open-Meteo / ECMWF ERA5</span></footer>

<dialog bind:this={drawer} aria-labelledby="new-heading">
  <div class="dialog-head"><h2 id="new-heading">New agreement</h2><button class="text-btn" aria-label="Close" onclick={() => drawer.close()}>Close ×</button></div>
  <p>Lock terms before your booking. The named customer must accept before the UTC window begins.</p>
  {#if problem}<p class="error" role="status">{problem}</p>{/if}
  <form class="proposal" onsubmit={propose}>
    <label>Booking title<input bind:value={form.title} required minlength="3" maxlength="60" placeholder="Riverside walking tour"></label>
    <label>Customer wallet<input bind:value={form.guest} required maxlength="42" placeholder="0x…"></label>
    <div class="form-grid"><label>Latitude<input type="number" bind:value={form.lat} required min="-90" max="90" step=".01"></label><label>Longitude<input type="number" bind:value={form.lon} required min="-180" max="180" step=".01"></label></div>
    <div class="form-grid"><label>Start day · UTC<input type="date" bind:value={form.start} required min={tomorrow()}></label><label>End day · UTC<input type="date" bind:value={form.end} required min={form.start}></label></div>
    <div class="form-grid"><label>Rain trigger · mm<input type="number" bind:value={form.threshold} required min="0.1" max="1000" step=".1"></label><label>Service credit · units<input type="number" bind:value={form.credits} required min="1" max="10000"></label></div>
    <button class="primary" disabled={busy}>Submit agreement ↗</button>
  </form>
</dialog>
