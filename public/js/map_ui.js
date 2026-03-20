// ============================================================
// VistaX — public/js/map_ui.js
// Interacción UI: modales, panel lateral, lotes, historial
// Depende de: MapEngine, Socket.IO, APP_CONFIG, LOTE_ACTIVO
// ============================================================

const MapUI = (() => {

  // ------ Estado --------------------------------------------
  let loteActivo   = window.LOTE_ACTIVO || null;
  let loteIdExport = loteActivo ? loteActivo.id : null;
  let surcoEstado  = {};  // { bajada: { spm, alerta, tipo } }

  // ============================================================
  // SOCKET.IO — recibir datos del backend
  // ============================================================
  const socket = io();

  socket.on('map_point', punto => {
    if (!loteActivo) return;

    // Actualizar estado del panel lateral
    if (punto.surcos) {
      Object.entries(punto.surcos).forEach(([bajada, spm]) => {
        const sc = MapEngine.SURCOS_CONFIG.find(s => s.bajada === parseInt(bajada));
        surcoEstado[bajada] = {
          spm,
          alerta: parseFloat(spm) === 0 && (punto.vel || 0) > 1.5,
          tipo:   sc ? sc.tipo : 'semilla',
        };
        actualizarDetalleEnVivo(parseInt(bajada), parseFloat(spm) || 0);
      });
      actualizarPanelSurcos();
    }

    MapEngine.pintarPuntoGPS(punto);
  });

  socket.on('map_stats', stats => {
    if (!stats) return;
    _set('stat-ha',   stats.hectareasAprox      || '—');
    _set('stat-dist', stats.distanciaRecorridaM || '—');
    _set('stat-min',  stats.spmMin              || '—');
    _set('stat-max',  stats.spmMax              || '—');
    _set('hkpi-ha',   (stats.hectareasAprox || '—') + ' ha');
  });

  // ============================================================
  // MODAL DETALLE SURCO
  // ============================================================
  function abrirDetalle(bajada, tipo) {
    const estado   = surcoEstado[bajada] || { spm: 0, alerta: false };
    const spm      = parseFloat(estado.spm) || 0;
    const objetivo = MapEngine.OBJETIVO_DEFAULT;
    const pct      = objetivo > 0 ? Math.min((spm / objetivo) * 100, 200) : 0;
    const color    = _colorDetalle(spm, pct);

    _set('detalle-tipo',   (tipo || 'semilla').replace(/_/g, ' ').toUpperCase());
    _set('detalle-titulo', `SURCO ${bajada}`);
    _set('detalle-spm-valor', spm > 0 ? spm.toFixed(1) : '—');
    _style('detalle-spm-valor', 'color', color);
    _style('detalle-barra', 'width',      Math.min(pct, 100) + '%');
    _style('detalle-barra', 'background', color);
    _set('detalle-barra-obj', `Objetivo: ${objetivo}`);
    _set('detalle-barra-max', objetivo * 2);
    _style('detalle-tapado-aviso', 'display', spm === 0 ? 'block' : 'none');

    const overlay = document.getElementById('detalle-overlay');
    if (overlay) {
      overlay.dataset.bajada = bajada;
      overlay.classList.add('abierto');
    }
  }

  function cerrarDetalle() {
    const overlay = document.getElementById('detalle-overlay');
    if (overlay) overlay.classList.remove('abierto');
  }

  function actualizarDetalleEnVivo(bajada, spm) {
    const overlay = document.getElementById('detalle-overlay');
    if (!overlay || !overlay.classList.contains('abierto')) return;
    if (parseInt(overlay.dataset.bajada) !== bajada) return;

    const objetivo = MapEngine.OBJETIVO_DEFAULT;
    const pct      = objetivo > 0 ? Math.min((spm / objetivo) * 100, 200) : 0;
    const color    = _colorDetalle(spm, pct);

    _set('detalle-spm-valor', spm > 0 ? spm.toFixed(1) : '—');
    _style('detalle-spm-valor', 'color',      color);
    _style('detalle-barra',     'width',      Math.min(pct, 100) + '%');
    _style('detalle-barra',     'background', color);
    _style('detalle-tapado-aviso', 'display', spm === 0 ? 'block' : 'none');
  }

  // Cerrar al hacer click fuera del box
  const overlayDetalle = document.getElementById('detalle-overlay');
  if (overlayDetalle) {
    overlayDetalle.addEventListener('click', e => {
      if (e.target === overlayDetalle) cerrarDetalle();
    });
  }

  // ============================================================
  // PANEL LATERAL — lista de surcos clicables
  // ============================================================
  function actualizarPanelSurcos() {
    const lista = document.getElementById('surcos-lista');
    if (!lista || !Object.keys(surcoEstado).length) return;
    lista.innerHTML = '';

    MapEngine.SURCOS_CONFIG.forEach(sc => {
      const estado = surcoEstado[sc.bajada] || { spm: 0, alerta: false };
      const spm    = parseFloat(estado.spm) || 0;
      const color  = MapEngine.spmAColor(spm);

      const row       = document.createElement('div');
      row.className   = 'surco-row' + (spm === 0 ? ' surco-alerta' : '');
      row.title       = 'Click para ver detalle';
      row.innerHTML   = `
        <div class="surco-dot" style="background:${color}"></div>
        <span class="surco-num">Bajada ${sc.bajada}</span>
        <span class="surco-val" style="color:${color}">${spm > 0 ? spm.toFixed(1) + ' s/m' : 'TAPADO'}</span>
      `;
      row.onclick = () => abrirDetalle(sc.bajada, sc.tipo);
      lista.appendChild(row);
    });
  }

  // ============================================================
  // GESTIÓN DE LOTES
  // ============================================================
  function abrirModalIniciar() {
    const modal = document.getElementById('modal-lote-nuevo');
    if (modal) modal.classList.remove('hidden');
    setTimeout(() => {
      const inp = document.getElementById('inp-nombre');
      if (inp) inp.focus();
    }, 50);
  }

  function cerrarModalIniciar() {
    const modal = document.getElementById('modal-lote-nuevo');
    if (modal) modal.classList.add('hidden');
  }

  async function iniciarLote() {
    const nombre       = document.getElementById('inp-nombre')?.value.trim();
    const cultivo      = document.getElementById('inp-cultivo')?.value;
    const anchoPasada  = parseFloat(document.getElementById('inp-ancho')?.value)        || MapEngine.ANCHO_DEFAULT;
    const surcosCentro = parseInt(document.getElementById('inp-surco-centro')?.value)   || 0;

    if (!nombre) {
      const inp = document.getElementById('inp-nombre');
      if (inp) inp.style.borderColor = '#ff1744';
      return;
    }

    MapEngine.setAnchoPasada(anchoPasada);
    MapEngine.setSurcosCentro(surcosCentro);

    const res = await fetch('/api/mapa/iniciar', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ nombre, cultivo, anchoPasada }),
    });

    if (!res.ok) { toast('Error al iniciar el lote', true); return; }

    const data   = await res.json();
    loteActivo   = data.lote;
    loteIdExport = data.lote.id;
    surcoEstado  = {};

    MapEngine.resetear();
    cerrarModalIniciar();
    actualizarUILote();
    toast(`Lote "${nombre}" iniciado — ${MapEngine.TOTAL_SURCOS} surcos`);
    cargarHistorial();
  }

  async function cerrarLote() {
    if (!loteActivo) return;
    if (!confirm(`¿Cerrás el lote "${loteActivo.nombre}"?`)) return;

    const res  = await fetch('/api/mapa/cerrar', { method: 'POST' });
    const data = await res.json();

    if (data.ok) {
      loteIdExport = data.lote.id;
      loteActivo   = null;
      actualizarUILote();
      cargarHistorial();
      const btnExp = document.getElementById('btn-export');
      if (btnExp) btnExp.style.display = 'inline-flex';
      toast('Lote cerrado — GeoJSON listo');
    }
  }

  async function exportarLote() {
    if (!loteIdExport) return;
    window.open(`/api/mapa/export/${loteIdExport}`, '_blank');
  }

  function actualizarUILote() {
    const badge  = document.getElementById('lote-badge');
    const txtNom = document.getElementById('txt-lote-nombre');
    const recDot = document.getElementById('rec-dot');
    const btnIni = document.getElementById('btn-iniciar');
    const btnCer = document.getElementById('btn-cerrar');

    if (loteActivo) {
      if (txtNom) txtNom.textContent = loteActivo.nombre.toUpperCase();
      if (badge)  badge.className    = 'lote-badge activo';
      if (recDot) recDot.style.display = 'block';
      if (btnIni) btnIni.style.display = 'none';
      if (btnCer) btnCer.style.display = 'inline-flex';
    } else {
      if (txtNom) txtNom.textContent = 'SIN LOTE ACTIVO';
      if (badge)  badge.className    = 'lote-badge';
      if (recDot) recDot.style.display = 'none';
      if (btnIni) btnIni.style.display = 'inline-flex';
      if (btnCer) btnCer.style.display = 'none';
    }
  }

  // ============================================================
  // HISTORIAL
  // ============================================================
  async function cargarHistorial() {
    const res   = await fetch('/api/mapa/historial');
    const lotes = await res.json();
    const lista = document.getElementById('historial-lista');
    if (!lista) return;
    lista.innerHTML = '';

    if (!lotes.length) {
      lista.innerHTML = '<p style="font-size:11px;color:#333;text-align:center;padding:10px">Sin lotes grabados</p>';
      return;
    }

    lotes.forEach(l => {
      const fecha = new Date(l.startTs).toLocaleDateString('es-AR');
      const div   = document.createElement('div');
      div.className = 'historial-item' + (loteActivo && loteActivo.id === l.id ? ' activo' : '');
      div.innerHTML = `
        <div class="hi-nombre">${l.nombre}</div>
        <div class="hi-meta">
          <span>${l.cultivo}</span>
          <span>${fecha}</span>
          <span>${l.puntos} pts GPS</span>
          ${l.estadisticas && l.estadisticas.hectareasAprox ? '<span>'+l.estadisticas.hectareasAprox+' ha</span>' : ''}
          ${!l.endTs ? '<span style="color:var(--danger)">● GRABANDO</span>' : ''}
        </div>`;
      div.onclick = () => cargarLoteEnMapa(l.id);
      lista.appendChild(div);
    });
  }

  async function cargarLoteEnMapa(loteId) {
    const res = await fetch(`/api/mapa/geojson/${loteId}`);
    if (!res.ok) { toast('Sin GeoJSON para este lote', true); return; }

    const geojson = await res.json();
    MapEngine.resetear();
    surcoEstado = {};

    geojson.features.forEach(f => {
      const [lon, lat] = f.geometry.coordinates;
      const p = f.properties;
      const surcos = {};
      MapEngine.SURCOS_CONFIG.forEach(sc => {
        if (p[sc.bajada] !== undefined) surcos[sc.bajada] = p[sc.bajada];
      });
      if (p.surcos) Object.assign(surcos, p.surcos);
      MapEngine.pintarPuntoGPS({ lat, lon, heading: p.heading || 0, vel: p.vel, ts: p.ts, surcos });
    });

    loteIdExport = loteId;
    const btnExp = document.getElementById('btn-export');
    if (btnExp) btnExp.style.display = 'inline-flex';

    const nombre = geojson.metadata && geojson.metadata.nombre ? geojson.metadata.nombre : loteId;
    toast(`Lote cargado: ${nombre}`);

    try { MapEngine.map.fitBounds(MapEngine.capas.surcos.getBounds(), { padding: [40,40] }); } catch(e) {}
  }

  // ============================================================
  // TOAST
  // ============================================================
  function toast(msg, error = false) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className   = 'toast show' + (error ? ' error' : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 3500);
  }

  // ============================================================
  // HELPERS PRIVADOS
  // ============================================================
  function _set(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function _style(id, prop, val) {
    const el = document.getElementById(id);
    if (el) el.style[prop] = val;
  }

  function _colorDetalle(spm, pct) {
    if (spm === 0)  return '#ff1744';
    if (pct < 70)   return '#ffb300';
    if (pct > 130)  return '#00e5ff';
    return '#00e676';
  }

  // ============================================================
  // INIT
  // ============================================================
  (async () => {
    actualizarUILote();
    console.log(`[VistaX Mapa] ${MapEngine.TOTAL_SURCOS} surcos. Ancho: ${MapEngine.ANCHO_DEFAULT}m`);

    // Si hay lote activo (SSR), cargar puntos ya grabados
    if (loteActivo && loteActivo.id) {
      MapEngine.setAnchoPasada(loteActivo.anchoPasada || MapEngine.ANCHO_DEFAULT);
      try {
        const geoRes  = await fetch('/api/mapa/geojson/live');
        const geojson = await geoRes.json();
        geojson.features.forEach(f => {
          const [lon, lat] = f.geometry.coordinates;
          const p = f.properties;
          const surcos = {};
          MapEngine.SURCOS_CONFIG.forEach(sc => {
            if (p[sc.bajada] !== undefined) surcos[sc.bajada] = p[sc.bajada];
          });
          if (p.surcos) Object.assign(surcos, p.surcos);
          MapEngine.pintarPuntoGPS({ lat, lon, heading: p.heading || 0, vel: p.vel, ts: p.ts, surcos });
        });
        if (geojson.features.length > 0) {
          try { MapEngine.map.fitBounds(MapEngine.capas.surcos.getBounds(), { padding: [40,40] }); } catch(e) {}
        }
      } catch(e) {
        console.warn('[VistaX Mapa] No se pudo cargar GeoJSON live:', e);
      }
    }

    cargarHistorial();
  })();

  // ============================================================
  // API pública
  // ============================================================
  return {
    abrirDetalle,
    cerrarDetalle,
    abrirModalIniciar,
    cerrarModalIniciar,
    iniciarLote,
    cerrarLote,
    exportarLote,
    cargarHistorial,
    toast,
  };

})();
