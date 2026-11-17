(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  Helpers
   * ------------------------------------------------------------------ */
  const $ = (id) => document.getElementById(id);
  const Cap = window.Capacitor;
  const isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  const getPlugin = (name) => {
    try { return (Cap.Plugins && Cap.Plugins[name]) || Cap.registerPlugin(name); } catch (e) { return null; }
  };
  const BG = isNative ? getPlugin('BackgroundGeolocation') : null;
  const LN = isNative ? getPlugin('LocalNotifications') : null;
  const AppPlugin = isNative ? getPlugin('App') : null;

  const store = {
    get(k, d) { try { const v = localStorage.getItem('ba.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('ba.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };

  const M_PER_MI = 1609.344;
  const RADII = { 402: '¼ mi', 805: '½ mi', 1609: '1 mi', 3219: '2 mi' };
  const FALLBACK_CENTER = [42.6584, -83.1499];

  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function fmtDist(m) {
    if (m < 161) return Math.max(10, Math.round((m * 3.28084) / 10) * 10) + ' ft';
    const mi = m / M_PER_MI;
    return mi.toFixed(mi >= 10 ? 0 : 1) + ' mi';
  }

  function fmtAgo(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + 's ago';
    return Math.round(s / 60) + ' min ago';
  }

  let toastTimer = 0;
  function toast(msg, ms = 3500) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // Promise-based dialog: resolves { action, value }
  function dialog({ title, body = '', input = null, actions }) {
    return new Promise((resolve) => {
      $('modal-title').textContent = title;
      $('modal-body').textContent = body;
      $('modal-body').hidden = !body;
      const inp = $('modal-input');
      inp.hidden = input === null;
      if (input !== null) inp.value = input;
      const box = $('modal-actions');
      box.innerHTML = '';
      const close = (action) => { $('modal').hidden = true; resolve({ action, value: inp.value.trim() }); };
      actions.forEach((a) => {
        const b = document.createElement('button');
        b.textContent = a.label;
        if (a.main) b.className = 'main';
        b.onclick = () => close(a.id);
        box.appendChild(b);
      });
      $('modal').hidden = false;
      if (input !== null) setTimeout(() => { inp.focus(); inp.select(); }, 50);
    });
  }

  /* ------------------------------------------------------------------ *
   *  State
   * ------------------------------------------------------------------ */
  let stop = store.get('stop', null);          // { lat, lng, title, sub }
  let radius = store.get('radius', 805);       // metres
  let saved = store.get('saved', []);          // [{ name, lat, lng, title, sub }]
  let mode = 'setup';                          // setup | active | alarm
  let userLL = null;                           // { lat, lng, accuracy }
  let lastFixAt = 0;
  let watcherId = null;
  let webWatchId = null;
  let firstFix = true;
  let startDist = 0;
  let fitted = false;

  if (!RADII[radius]) radius = 805;

  /* ------------------------------------------------------------------ *
   *  Map
   * ------------------------------------------------------------------ */
  const map = L.map('map', { zoomControl: false, attributionControl: false, zoomSnap: 0.5 })
    .setView(stop ? [stop.lat, stop.lng] : FALLBACK_CENTER, stop ? 15 : 13);
  L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);

  const pinIcon = L.divIcon({
    className: 'pin-wrap', iconSize: [44, 56], iconAnchor: [22, 54],
    html: '<div class="pin"><svg viewBox="0 0 44 56"><defs><linearGradient id="pg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6f9bff"/><stop offset="1" stop-color="#8a5bff"/></linearGradient></defs><path d="M22 2C11.5 2 3 10.3 3 20.6 3 34 22 54 22 54s19-20 19-33.4C41 10.3 32.5 2 22 2z" fill="url(#pg)" stroke="#fff" stroke-width="2.5"/><circle cx="22" cy="21" r="7" fill="#fff"/></svg></div>',
  });
  const meIcon = L.divIcon({ className: 'me-wrap', iconSize: [22, 22], iconAnchor: [11, 11], html: '<div class="me"><i></i></div>' });

  let stopMarker = null, zoneCircle = null, meMarker = null;

  // Keep CSS in sync with the sheet height so floating controls sit above it.
  const sheet = $('sheet');
  const syncSheet = () => document.documentElement.style.setProperty('--sheet-h', sheet.offsetHeight + 'px');
  if (window.ResizeObserver) new ResizeObserver(syncSheet).observe(sheet);
  syncSheet();

  // Centre the map so a point appears in the visible area above the sheet.
  function focus(ll, zoom) {
    const z = zoom || map.getZoom();
    const p = map.project(L.latLng(ll.lat, ll.lng), z).add([0, sheet.offsetHeight / 2 - 30]);
    map.flyTo(map.unproject(p, z), z, { duration: 0.8 });
  }

  function drawStop() {
    if (!stop) {
      if (stopMarker) { map.removeLayer(stopMarker); stopMarker = null; }
      if (zoneCircle) { map.removeLayer(zoneCircle); zoneCircle = null; }
      return;
    }
    const ll = [stop.lat, stop.lng];
    if (!stopMarker) {
      stopMarker = L.marker(ll, { icon: pinIcon, draggable: true, autoPan: false }).addTo(map);
      stopMarker.on('dragend', () => { if (mode === 'setup') setStop(stopMarker.getLatLng()); else stopMarker.setLatLng([stop.lat, stop.lng]); });
    } else {
      stopMarker.setLatLng(ll);
    }
    if (!zoneCircle) {
      zoneCircle = L.circle(ll, { radius, color: '#5b8cff', weight: 2, dashArray: '6 6', fillColor: '#5b8cff', fillOpacity: 0.13, interactive: false }).addTo(map);
    } else {
      zoneCircle.setLatLng(ll).setRadius(radius);
    }
  }

  function drawMe() {
    if (!userLL) return;
    if (!meMarker) meMarker = L.marker([userLL.lat, userLL.lng], { icon: meIcon, interactive: false, zIndexOffset: -100 }).addTo(map);
    else meMarker.setLatLng([userLL.lat, userLL.lng]);
  }

  /* ------------------------------------------------------------------ *
   *  Stop selection
   * ------------------------------------------------------------------ */
  const sameSpot = (a, b) => haversine(a, b) < 25;
  const isSaved = () => stop && saved.some((s) => sameSpot(s, stop));

  function setStop(ll, opts = {}) {
    stop = {
      lat: ll.lat, lng: ll.lng,
      title: opts.title || 'Dropped pin',
      sub: opts.sub || 'Looking up address…',
    };
    store.set('stop', stop);
    drawStop();
    renderStop();
    if (opts.fly) focus(stop, Math.max(map.getZoom(), 16));
    if (!opts.title) reverseGeocode(stop);
  }

  async function fetchJSON(url) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 9000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  let revSeq = 0;
  async function reverseGeocode(s) {
    const seq = ++revSeq;
    try {
      const r = await fetchJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=en&lat=${s.lat}&lon=${s.lng}`);
      if (seq !== revSeq || !stop) return;
      const a = r.address || {};
      const road = a.road || a.pedestrian || a.footway || a.path;
      const title = r.name || (road ? (a.house_number ? a.house_number + ' ' : '') + road : (r.display_name || '').split(',')[0]) || 'Dropped pin';
      const place = a.suburb || a.neighbourhood || a.city || a.town || a.village || a.hamlet || a.county;
      stop.title = title;
      stop.sub = [place, a.state].filter(Boolean).join(', ') || 'Pinned location';
      store.set('stop', stop);
      renderStop();
    } catch (e) {
      if (seq === revSeq && stop) { stop.sub = 'Pinned location'; store.set('stop', stop); renderStop(); }
    }
  }

  function renderStop() {
    const has = !!stop;
    $('stop-title').textContent = has ? stop.title : 'No stop selected';
    let sub = has ? stop.sub : 'Tap the map to drop a pin on your stop';
    if (has && userLL && stop.sub !== 'Looking up address…') sub = fmtDist(haversine(userLL, stop)) + ' away · ' + sub;
    $('stop-sub').textContent = sub;
    $('start').disabled = !has;
    const star = $('save-stop');
    star.hidden = !has;
    star.classList.toggle('on', !!isSaved());
    renderSaved();
    renderRadius();
  }

  function renderSaved() {
    const el = $('saved');
    el.innerHTML = '';
    el.hidden = saved.length === 0;
    saved.forEach((s) => {
      const b = document.createElement('button');
      b.className = 'chip' + (stop && sameSpot(s, stop) ? ' on' : '');
      b.textContent = '★ ' + s.name;
      b.onclick = () => setStop({ lat: s.lat, lng: s.lng }, { fly: true, title: s.title || s.name, sub: s.sub || 'Saved stop' });
      el.appendChild(b);
    });
  }

  function renderRadius() {
    document.querySelectorAll('#radius-chips .chip').forEach((c) => {
      const on = Number(c.dataset.m) === radius;
      c.classList.toggle('on', on);
      c.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    $('radius-val').textContent = RADII[radius];
    // Rough lead time at a typical city-bus pace (~20 mph).
    const mins = radius / 8.9 / 60;
    const txt = mins < 1.25 ? '1 min' : (Math.round(mins * 2) / 2) + ' min';
    $('radius-hint').textContent = `About ${txt} before your stop on a typical bus.`;
    if (zoneCircle) zoneCircle.setRadius(radius);
  }

  document.querySelectorAll('#radius-chips .chip').forEach((c) => {
    c.onclick = () => { radius = Number(c.dataset.m); store.set('radius', radius); renderRadius(); };
  });

  map.on('click', () => { hideResults(); $('q').blur(); });
  map.on('click', (e) => {
    if (mode !== 'setup') return;
    setStop(e.latlng);
    // Nudge the view only if the pin landed under the sheet.
    const pt = map.latLngToContainerPoint(e.latlng);
    if (pt.y > window.innerHeight - sheet.offsetHeight - 40) focus(e.latlng);
  });

  $('save-stop').onclick = async () => {
    if (!stop) return;
    if (isSaved()) {
      saved = saved.filter((s) => !sameSpot(s, stop));
      store.set('saved', saved);
      renderStop();
      toast('Removed from saved stops');
      return;
    }
    const r = await dialog({
      title: 'Save this stop', body: 'Give it a short name so you can pick it again in one tap.',
      input: stop.title && stop.title !== 'Dropped pin' ? stop.title.slice(0, 30) : '',
      actions: [{ id: 'no', label: 'Cancel' }, { id: 'ok', label: 'Save', main: true }],
    });
    if (r.action !== 'ok') return;
    saved.push({ name: r.value || stop.title || 'My stop', lat: stop.lat, lng: stop.lng, title: stop.title, sub: stop.sub });
    store.set('saved', saved);
    renderStop();
    toast('Saved');
  };

  /* ------------------------------------------------------------------ *
   *  Search
   * ------------------------------------------------------------------ */
  const qEl = $('q'), resEl = $('results');
  let searchTimer = 0, searchSeq = 0;

  function hideResults() { resEl.hidden = true; }

  function showResults(items, emptyMsg) {
    resEl.innerHTML = '';
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'r-empty';
      li.textContent = emptyMsg || 'No results';
      resEl.appendChild(li);
    }
    items.forEach((it) => {
      const li = document.createElement('li');
      const t = document.createElement('div'); t.className = 'r-title'; t.textContent = it.title;
      const s = document.createElement('div'); s.className = 'r-sub'; s.textContent = it.sub;
      li.append(t, s);
      li.onclick = () => {
        hideResults(); qEl.blur(); qEl.value = ''; $('qclear').hidden = true;
        setStop({ lat: it.lat, lng: it.lng }, { fly: true, title: it.title, sub: it.sub });
      };
      resEl.appendChild(li);
    });
    resEl.hidden = false;
  }

  async function runSearch() {
    const q = qEl.value.trim();
    if (q.length < 3) { hideResults(); return; }
    const seq = ++searchSeq;
    const b = map.getBounds();
    const vb = [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].join(',');
    try {
      const data = await fetchJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&accept-language=en&viewbox=${vb}&q=${encodeURIComponent(q)}`);
      if (seq !== searchSeq) return;
      showResults(data.map((d) => {
        const parts = (d.display_name || '').split(',').map((x) => x.trim());
        return { lat: parseFloat(d.lat), lng: parseFloat(d.lon), title: d.name || parts[0] || 'Place', sub: parts.slice(1, 4).join(', ') };
      }), 'No matches. Try a street name or place.');
    } catch (e) {
      if (seq === searchSeq) showResults([], "Couldn't search. Check your connection.");
    }
  }

  qEl.addEventListener('input', () => {
    $('qclear').hidden = qEl.value === '';
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 500);
  });
  qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(); qEl.blur(); } });
  $('qclear').onclick = () => { qEl.value = ''; $('qclear').hidden = true; hideResults(); qEl.focus(); };

  /* ------------------------------------------------------------------ *
   *  Locate me (one-shot)
   * ------------------------------------------------------------------ */
  function locate(flyTo) {
    if (!navigator.geolocation) { toast('Location is not available on this device'); return; }
    navigator.geolocation.getCurrentPosition((p) => {
      userLL = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy };
      drawMe(); renderStop();
      if (flyTo) focus(userLL, Math.max(map.getZoom(), 15));
    }, () => { if (flyTo) toast("Couldn't get your location. Check that location is on."); },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  }
  $('locate').onclick = () => { if (userLL) focus(userLL, Math.max(map.getZoom(), 15)); locate(!userLL); };

  /* ------------------------------------------------------------------ *
   *  Alarm sound (pre-rendered loop, so it needs no timers in the background)
   * ------------------------------------------------------------------ */
  let ac = null, sirenSrc = null, sirenGain = null, testTimer = 0, vibTimer = 0;

  function initAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!ac) ac = new AC();
    if (ac.state === 'suspended') ac.resume();
    // Play a silent blip inside the user's tap so audio is unlocked for later.
    try {
      const s = ac.createBufferSource();
      s.buffer = ac.createBuffer(1, 1, 22050);
      s.connect(ac.destination);
      s.start(0);
    } catch (e) { /* ignore */ }
  }

  function makeSirenBuffer() {
    const sr = ac.sampleRate, len = Math.floor(sr * 1.6);
    const buf = ac.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      let v = 0;
      if (t < 1.0) {
        const idx = Math.floor(t / 0.25), local = t - idx * 0.25;
        if (local < 0.17) {
          const f = idx % 2 ? 1319 : 988;
          const env = Math.min(1, local / 0.006, (0.17 - local) / 0.01);
          const ph = 2 * Math.PI * f * t;
          v = env * (0.6 * Math.sign(Math.sin(ph)) + 0.4 * Math.sin(ph)) * 0.85;
        }
      }
      d[i] = v;
    }
    return buf;
  }

  function playSiren({ test = false } = {}) {
    initAudio();
    if (!ac) return;
    stopSiren();
    sirenSrc = ac.createBufferSource();
    sirenSrc.buffer = makeSirenBuffer();
    sirenSrc.loop = true;
    sirenGain = ac.createGain();
    const now = ac.currentTime;
    if (test) {
      sirenGain.gain.setValueAtTime(0.7, now);
    } else {
      // Start firm, reach full volume within ~15 s.
      sirenGain.gain.setValueAtTime(0.5, now);
      sirenGain.gain.linearRampToValueAtTime(1.0, now + 15);
    }
    sirenSrc.connect(sirenGain).connect(ac.destination);
    sirenSrc.start();
    if (test) { clearTimeout(testTimer); testTimer = setTimeout(stopSiren, 2600); }
  }

  function stopSiren() {
    clearTimeout(testTimer);
    try { if (sirenSrc) sirenSrc.stop(); } catch (e) { /* ignore */ }
    try { if (sirenSrc) sirenSrc.disconnect(); if (sirenGain) sirenGain.disconnect(); } catch (e) { /* ignore */ }
    sirenSrc = null; sirenGain = null;
  }

  function startVibration() {
    const buzz = () => { try { navigator.vibrate && navigator.vibrate([700, 250, 700, 250, 700]); } catch (e) { /* ignore */ } };
    buzz();
    clearInterval(vibTimer);
    vibTimer = setInterval(buzz, 3000);
  }
  function stopVibration() {
    clearInterval(vibTimer);
    try { navigator.vibrate && navigator.vibrate(0); } catch (e) { /* ignore */ }
  }

  $('test').onclick = () => { playSiren({ test: true }); toast('Playing at your current media volume'); };

  /* ------------------------------------------------------------------ *
   *  Tracking
   * ------------------------------------------------------------------ */
  const NOTIF_CHANNEL = 'arrival-alarm';

  function setMode(m) {
    mode = m;
    $('view-setup').hidden = m !== 'setup';
    $('view-active').hidden = m === 'setup';
    $('alarm').hidden = m !== 'alarm';
    $('save-stop').hidden = m !== 'setup' || !stop;
    syncSheet();
  }

  async function ensureNotifications() {
    if (!LN) return;
    try {
      await LN.requestPermissions();
      await LN.createChannel({
        id: NOTIF_CHANNEL, name: 'Arrival alarm', description: 'Wakes you up when you are near your stop',
        importance: 5, visibility: 1, vibration: true, lights: true, sound: 'alarm.wav',
      });
    } catch (e) { /* notifications are a backup; the siren still plays */ }
  }

  async function firstRunTips() {
    if (store.get('tips', false)) return;
    store.set('tips', true);
    const r = await dialog({
      title: 'Before you fall asleep',
      body: '1. Turn your media volume up.\n2. Allow location when asked ("While using the app" is enough).\n3. On Samsung: Settings → Apps → Bus Alarm → Battery → Unrestricted, so the phone never puts the alarm to sleep.',
      actions: BG ? [{ id: 'settings', label: 'Open settings' }, { id: 'ok', label: 'Got it', main: true }] : [{ id: 'ok', label: 'Got it', main: true }],
    });
    if (r.action === 'settings' && BG) { try { await BG.openSettings(); } catch (e) { /* ignore */ } return false; }
    return true;
  }

  async function startAlarm() {
    if (!stop || mode !== 'setup') return;
    initAudio();                              // unlock sound inside the tap
    const proceed = await firstRunTips();
    if (proceed === false) return;
    initAudio();

    firstFix = true; fitted = false; startDist = 0;
    lastFixAt = 0;
    $('dist').textContent = '--';
    $('dist-sub').textContent = 'Waiting for GPS…';
    $('bar').style.width = '0%';
    $('active-stop').textContent = stop.title;
    setMode('active');

    await ensureNotifications();

    try {
      if (isNative && BG) {
        watcherId = await BG.addWatcher({
          backgroundTitle: 'Bus Alarm is on',
          backgroundMessage: 'Waking you up near ' + stop.title,
          requestPermissions: true, stale: false, distanceFilter: 15,
        }, onFix);
      } else if (navigator.geolocation) {
        webWatchId = navigator.geolocation.watchPosition(
          (p) => onFix({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy, time: p.timestamp }),
          (err) => onFix(null, { code: err.code === 1 ? 'NOT_AUTHORIZED' : 'ERR', message: err.message }),
          { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 });
      } else {
        throw new Error('no geolocation');
      }
    } catch (e) {
      endTracking();
      toast("Couldn't start location tracking.");
    }
  }

  async function removeWatchers() {
    if (watcherId !== null && BG) { try { await BG.removeWatcher({ id: watcherId }); } catch (e) { /* ignore */ } }
    watcherId = null;
    if (webWatchId !== null) { navigator.geolocation.clearWatch(webWatchId); webWatchId = null; }
  }

  async function endTracking() {
    await removeWatchers();
    stopSiren(); stopVibration();
    if (LN) { try { await LN.cancel({ notifications: [{ id: 42 }] }); } catch (e) { /* ignore */ } }
    setMode('setup');
    renderStop();
  }

  function onFix(loc, err) {
    if (err) {
      if (err.code === 'NOT_AUTHORIZED') {
        endTracking();
        dialog({
          title: 'Location is off',
          body: 'Bus Alarm needs location access to know when you are near your stop. Open settings, allow location, then start again.',
          actions: BG ? [{ id: 'no', label: 'Not now' }, { id: 'go', label: 'Open settings', main: true }] : [{ id: 'no', label: 'OK', main: true }],
        }).then((r) => { if (r.action === 'go' && BG) BG.openSettings(); });
      } else if (mode === 'active' && !lastFixAt) {
        // Transient GPS hiccup: keep waiting, just say so quietly.
        $('dist-sub').textContent = 'Searching for GPS signal…';
      }
      return;
    }
    if (!loc || mode === 'setup') return;

    userLL = { lat: loc.latitude, lng: loc.longitude, accuracy: loc.accuracy };
    lastFixAt = Date.now();
    drawMe();
    const d = haversine(userLL, stop);

    if (mode === 'alarm') return;           // already ringing; keep tracking alive until dismissed

    if (firstFix) {
      firstFix = false;
      if (d <= radius) {
        endTracking();
        toast("You're already inside the wake-up zone. Pick a smaller distance or a farther stop.", 5500);
        return;
      }
      startDist = d;
    }
    if (!fitted && stopMarker) {
      fitted = true;
      map.fitBounds(L.latLngBounds([userLL.lat, userLL.lng], [stop.lat, stop.lng]), {
        paddingTopLeft: [50, 90], paddingBottomRight: [50, sheet.offsetHeight + 40], maxZoom: 16,
      });
    }
    updateActive(d);

    // Count a poor GPS fix in the user's favour so a sleeper is never woken late.
    const slack = Math.min(loc.accuracy || 0, 100);
    if (d - slack <= radius) triggerAlarm(d);
  }

  function updateActive(d) {
    $('dist').textContent = fmtDist(d);
    const pct = startDist > radius ? Math.min(100, Math.max(0, ((startDist - d) / (startDist - radius)) * 100)) : 0;
    $('bar').style.width = pct.toFixed(0) + '%';
    refreshAgo();
  }

  function refreshAgo() {
    if (mode !== 'active') return;
    if (!lastFixAt) return;
    const age = Date.now() - lastFixAt;
    $('dist-sub').textContent = age > 90000
      ? 'GPS signal weak · last update ' + fmtAgo(age)
      : 'to ' + (stop ? stop.title : 'your stop');
  }
  setInterval(refreshAgo, 15000);

  async function triggerAlarm(d) {
    if (mode === 'alarm') return;
    setMode('alarm');
    $('alarm-sub').textContent = `You're ${fmtDist(d)} from ${stop.title}.`;
    playSiren();
    startVibration();
    if (LN) {
      try {
        await LN.schedule({ notifications: [{
          id: 42, title: 'Wake up! Your stop is close',
          body: `${stop.title} is ${fmtDist(d)} away.`,
          channelId: NOTIF_CHANNEL,
          schedule: { at: new Date(Date.now() + 250) },
        }] });
      } catch (e) { /* the siren is the main alarm */ }
    }
  }

  $('start').onclick = startAlarm;
  $('cancel').onclick = endTracking;
  $('dismiss').onclick = endTracking;

  // Android back button: never close the app while an alarm is armed.
  if (AppPlugin && AppPlugin.addListener) {
    AppPlugin.addListener('backButton', () => {
      if (!$('modal').hidden) return;
      if (mode !== 'setup') { AppPlugin.minimizeApp && AppPlugin.minimizeApp(); return; }
      if (!resEl.hidden) { hideResults(); return; }
      AppPlugin.exitApp && AppPlugin.exitApp();
    });
  }

  /* ------------------------------------------------------------------ *
   *  Boot
   * ------------------------------------------------------------------ */
  setMode('setup');
  drawStop();
  renderStop();
  if (stop) focus(stop, 15);
  locate(!stop);
})();
