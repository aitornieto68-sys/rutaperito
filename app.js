// RutaPerito v2: todo se guarda en el móvil (IndexedDB) y sale en un ZIP hacia OneDrive.
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hoyISO = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const num = v => { const n = parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : 0; };
  const fmt = n => n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const slug = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "Estancia";
  const ESTANCIAS = ["Salón", "Cocina", "Dormitorio", "Baño", "Pasillo", "Fachada", "Terraza", "Patio", "Escalera", "Cubierta", "Garaje", "Otra"];
  const CONCEPTOS = ["Fisura en paramento", "Fisura en techo", "Pintura paramentos", "Pintura techo", "Alicatado", "Solado", "Falso techo / escayola", "Pintura fachada", "Enfoscado", "Cornisa / moldura", "Rodapié"];
  const ESTADOS = { pendiente: "Pendiente", en_curso: "En curso", terminada: "Enviada" };

  let visitas = [], actual = null, dia = hoyISO(), perito = localStorage.getItem("rp-perito") || "";
  let fotoEstancia = null, saveTimer = null, paquete = null, rec = null;

  // ---------- IndexedDB ----------
  let dbp;
  const idb = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open("rutaperito-v2", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("visitas", { keyPath: "id" }); r.result.createObjectStore("blobs", { keyPath: "id" }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  async function tx(store, mode, fn) {
    const d = await idb();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), req = fn(t.objectStore(store));
      t.oncomplete = () => res(req?.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || Error("Escritura cancelada (¿móvil sin espacio?)"));
    });
  }
  const dbVisitas = () => tx("visitas", "readonly", s => s.getAll());
  const dbPut = v => tx("visitas", "readwrite", s => s.put(v));
  const dbDel = id => tx("visitas", "readwrite", s => s.delete(id));
  const blobPut = (id, blob, name) => tx("blobs", "readwrite", s => s.put({ id, blob, name, at: new Date().toISOString() }));
  const blobGet = id => tx("blobs", "readonly", s => s.get(id));
  const blobDel = id => tx("blobs", "readwrite", s => s.delete(id));

  async function guardar(v = actual) {
    v.updatedAt = new Date().toISOString();
    try { await dbPut(v); } catch (e) { toast("⚠ No se pudo guardar: " + e.message, 8000); throw e; }
  }
  function guardarLuego() { clearTimeout(saveTimer); saveTimer = setTimeout(() => guardar().catch(() => {}), 400); }

  // ---------- Utilidades UI ----------
  let toastT;
  function toast(msg, ms = 3500) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms); }
  function progreso(txt) { $("progreso").hidden = !txt; $("progresoTxt").textContent = txt || ""; }
  const tels = v => (v.telefonos || []).map(t => String(t).replace(/\D/g, "")).filter(t => t.length >= 9);
  const dirMaps = v => [v.direccion, v.municipio || "Granada", "Granada"].filter(Boolean).join(", ");
  const mapsUrl = v => `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(dirMaps(v))}`;
  const waUrl = t => `https://wa.me/34${t.slice(-9)}`;
  function fechaCorta(iso) {
    if (!iso) return "Sin fecha";
    const d = new Date(iso + "T12:00:00");
    const txt = d.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "short" });
    return iso === hoyISO() ? "Hoy · " + txt : txt;
  }
  const esMia = v => !perito || !v.perito || v.perito === perito;

  // ---------- Agenda ----------
  function pintarHoy() {
    $("btnPerito").textContent = perito ? `${perito} · cambiar` : "¿Quién eres? Elegir perito";
    $("diaHoy").textContent = fechaCorta(dia);
    const verTodas = $("verTodas").checked;
    const visibles = visitas.filter(v => verTodas || esMia(v));
    const delDia = visibles.filter(v => v.fecha === dia).sort((a, b) => (a.hora || "99").localeCompare(b.hora || "99"));
    $("lista").innerHTML = delDia.length ? delDia.map(tarjeta).join("") : `<p class="vacio">No hay visitas este día.<br>Carga la agenda (📥) o añade una visita (＋).</p>`;
    const otros = visibles.filter(v => v.fecha !== dia && (v.estado === "en_curso" || !v.fecha)).sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""));
    $("listaOtros").innerHTML = otros.length ? otros.map(tarjeta).join("") : `<p class="sub">Nada pendiente fuera de este día.</p>`;
    $("btnRuta").disabled = !delDia.some(v => v.direccion);
  }
  function tarjeta(v) {
    const t = tels(v)[0];
    const nfotos = v.estancias.reduce((s, e) => s + e.fotos.length, 0);
    const otro = v.perito && perito && v.perito !== perito ? ` · ${esc(v.perito)}` : (!v.perito ? " · sin asignar" : "");
    return `<article class="vcard ${v.estado}">
      <div class="fila1"><span class="hora">${esc(v.hora || "--:--")}</span><span class="nombre">${esc(v.nombre)}</span><span class="badge ${v.estado}">${ESTADOS[v.estado]}</span></div>
      ${v.confirmada === false && v.estado === "pendiente" ? `<div class="aviso">⏳ Cita sin confirmar</div>` : ""}
      <div class="meta">Exp. ${esc(v.exp)} · ${esc([v.direccion, v.municipio].filter(Boolean).join(", ") || "sin dirección")}${otro}${v.fecha !== dia ? " · " + esc(fechaCorta(v.fecha)) : ""}</div>
      ${semaforo(v)}
      ${nfotos || v.inicio ? `<div class="meta">${v.inicio ? "✍ Inicio firmado · " : ""}${nfotos} fotos</div>` : ""}
      <div class="botones">
        ${t ? `<a class="btn" href="tel:${t}">📞</a><a class="btn" href="${waUrl(t)}" target="_blank" rel="noopener">💬</a>` : `<span></span><span></span>`}
        ${v.direccion ? `<a class="btn" href="${mapsUrl(v)}" target="_blank" rel="noopener">🧭</a>` : `<span></span>`}
        <button class="btn primary" data-abrir="${v.id}" type="button">Abrir</button>
      </div></article>`;
  }
  // Póliza y justificante de pago: verde si están en la carpeta del expediente, rojo si no (lo calcula el PC al exportar la agenda).
  function semaforo(v) {
    const d = v.documentacion;
    if (!d) return `<div class="semaforo"><span class="sem gris">Documentación sin revisar</span></div>`;
    return `<div class="semaforo"><span class="sem ${d.poliza ? "si" : "no"}">${d.poliza ? "✓" : "✗"} Póliza</span><span class="sem ${d.pago ? "si" : "no"}">${d.pago ? "✓" : "✗"} Justificante pago</span></div>`;
  }
  function pintarDocumentacion(v) {
    const d = v.documentacion, el = $("docEstado");
    if (!d) { el.innerHTML = `<p class="estado">Sin revisar. Carga la agenda actualizada (📥) para verlo.</p>`; return; }
    const fila = (ok, titulo, archivos, falta) => `<div class="docfila ${ok ? "si" : "no"}"><b>${ok ? "✓" : "✗"} ${titulo}</b>
      <span>${ok ? archivos.map(esc).join("<br>") : falta}</span></div>`;
    el.innerHTML = fila(d.poliza, "Póliza (condiciones particulares)", d.archivosPoliza || [], "No está en el expediente: pídesela al asegurado en la visita.")
      + fila(d.pago, "Justificante de pago (recibo / adeudo)", d.archivosPago || [], "No está en el expediente: pídele el recibo y el justificante bancario.")
      + `<p class="sub">Revisado el ${new Date(d.revisado).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" })}.</p>`;
  }
  function rutaDelDia() {
    const paradas = visitas.filter(v => v.fecha === dia && esMia(v) && v.direccion && v.estado !== "terminada").sort((a, b) => (a.hora || "99").localeCompare(b.hora || "99"));
    if (!paradas.length) return toast("No quedan visitas con dirección este día.");
    const destino = paradas[paradas.length - 1], intermedias = paradas.slice(0, -1).slice(0, 9);
    let url = `https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=${encodeURIComponent(dirMaps(destino))}`;
    if (intermedias.length) url += `&waypoints=${encodeURIComponent(intermedias.map(dirMaps).join("|"))}`;
    window.open(url, "_blank", "noopener");
  }

  // Normaliza una fila de agenda (JSON o CSV de Citas_*).
  function filaAgenda(o) {
    const g = (...k) => { for (const key of k) { const val = o[key] ?? o[key.toLowerCase()]; if (val != null && String(val).trim() !== "") return val; } return ""; };
    const exp = String(g("exp", "expediente", "Expediente")).trim();
    if (!exp) return null;
    let telefonos = g("telefonos", "moviles", "telefono", "movil", "fijos");
    telefonos = (Array.isArray(telefonos) ? telefonos : String(telefonos).split(/[\/,;|\s]+/)).map(String).filter(Boolean);
    const per = String(g("perito")).toLowerCase();
    let fecha = String(g("fecha", "dia", "fecha_visita")).trim();
    const m = fecha.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) fecha = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) fecha = "";
    return {
      exp, nombre: String(g("nombre", "asegurado", "insuredName")).trim() || "(sin nombre)",
      direccion: String(g("direccion", "riesgo", "address")).trim(), municipio: String(g("municipio", "poblacion")).trim(),
      telefonos, fecha, hora: String(g("hora", "time")).trim().slice(0, 5),
      perito: per.includes("aitor") ? "Aitor" : per.includes("ignacio") ? "Ignacio" : "",
      notas: String(g("notas", "nota")).trim(),
      confirmada: o.confirmada === false ? false : o.confirmada === true ? true : undefined,
      documentacion: o.documentacion && typeof o.documentacion === "object" ? o.documentacion : undefined
    };
  }
  function parseCSV(text) {
    const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter(l => l.trim());
    const sep = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ";" : ",";
    const head = lines[0].split(sep).map(h => h.trim().toLowerCase());
    return lines.slice(1).map(l => { const c = l.split(sep); return Object.fromEntries(head.map((h, i) => [h, (c[i] || "").trim()])); });
  }
  async function importarAgenda(file) {
    const text = await file.text();
    let filas;
    if (/\.csv$/i.test(file.name) || !/^\s*[\[{]/.test(text)) filas = parseCSV(text);
    else { const j = JSON.parse(text.replace(/^﻿/, "")); filas = Array.isArray(j) ? j : (j.visitas || j.expedientes || []); }
    let nuevas = 0, act = 0;
    for (const f of filas.map(filaAgenda).filter(Boolean)) {
      const ex = visitas.find(v => v.exp === f.exp && v.estado !== "terminada");
      if (ex) {
        // La agenda solo actualiza datos de cita; nunca toca fotos, medidas ni firma.
        Object.assign(ex, { nombre: f.nombre !== "(sin nombre)" ? f.nombre : ex.nombre, direccion: f.direccion || ex.direccion, municipio: f.municipio || ex.municipio,
          telefonos: f.telefonos.length ? f.telefonos : ex.telefonos, fecha: f.fecha || ex.fecha, hora: f.hora || ex.hora, perito: f.perito || ex.perito, notas: f.notas || ex.notas, confirmada: f.confirmada ?? ex.confirmada, documentacion: f.documentacion || ex.documentacion });
        await guardar(ex); act++;
      } else if (!visitas.some(v => v.exp === f.exp && v.fecha === f.fecha)) {
        const v = nuevaVisita(f); visitas.push(v); await guardar(v); nuevas++;
      }
    }
    toast(`Agenda cargada: ${nuevas} nuevas, ${act} actualizadas.`);
    const primera = visitas.filter(v => v.fecha >= hoyISO() && esMia(v)).map(v => v.fecha).sort()[0];
    if (!visitas.some(v => v.fecha === dia) && primera) dia = primera;
    pintarHoy();
  }
  const nuevaVisita = f => ({ id: uid(), ...f, estado: "pendiente", estancias: [], observaciones: "", inicio: null, envios: [], creada: new Date().toISOString() });

  // ---------- Visita ----------
  async function abrir(id) {
    actual = visitas.find(v => v.id === id);
    if (!actual) return;
    $("vHoy").hidden = true; $("vVisita").hidden = false; scrollTo(0, 0);
    history.pushState({ v: id }, "");
    pintarVisita();
  }
  function cerrarVisita() {
    pararDictado();
    if (actual) guardar().catch(() => {});
    actual = null; $("vVisita").hidden = true; $("vHoy").hidden = false; pintarHoy();
  }
  function pintarVisita() {
    const v = actual;
    $("vTitulo").textContent = `${v.exp} · ${v.nombre}`;
    $("vSub").textContent = [v.direccion, v.municipio].filter(Boolean).join(", ") + (v.hora ? ` · ${v.hora}` : "");
    const ts = tels(v);
    $("vContacto").innerHTML = ts.map(t => `<a class="btn small" href="tel:${t}">📞 ${t}</a><a class="btn small" href="${waUrl(t)}" target="_blank" rel="noopener">💬</a>`).join("")
      + (v.direccion ? `<a class="btn small" href="${mapsUrl(v)}" target="_blank" rel="noopener">🧭 Cómo llegar</a>` : "")
      + (v.notas ? `<p class="sub" style="flex-basis:100%">📝 ${esc(v.notas)}</p>` : "");
    pintarDocumentacion(v);
    const ini = $("inicioEstado");
    if (v.inicio) { ini.className = "estado ok"; ini.textContent = `✓ Firmado el ${RPPdf.fechaLarga(v.inicio.fecha)}${v.inicio.firmante ? " por " + v.inicio.firmante : ""}.`; $("btnFirmar").textContent = "Repetir firma"; $("btnFirmar").classList.remove("primary"); }
    else { ini.className = "estado pend"; ini.textContent = "Pendiente de firma del asegurado."; $("btnFirmar").textContent = "✍ Firmar Inicio de Peritación"; $("btnFirmar").classList.add("primary"); }
    $("chipsEstancia").innerHTML = ESTANCIAS.map(e => `<button class="chip" data-estancia="${e}" type="button">＋ ${e}</button>`).join("");
    $("obs").value = v.observaciones || "";
    pintarEstancias();
    pintarFin();
  }
  function pintarFin() {
    const v = actual, n = v.estancias.reduce((s, e) => s + e.fotos.length, 0), u = v.envios?.[v.envios.length - 1];
    const fe = $("finEstado");
    if (u) { fe.className = "estado ok"; fe.textContent = `Paquete ${u.confirmado ? "guardado en OneDrive" : "preparado"} el ${new Date(u.at).toLocaleString("es-ES")}. Si añades algo, vuelve a enviarlo.`; }
    else { fe.className = "estado"; fe.textContent = `${n} fotos · ${v.estancias.length} estancias · ${v.inicio ? "Inicio firmado" : "Inicio SIN firmar"}.`; }
  }
  let numFoto = new Map();
  function numerarFotos() { numFoto = new Map(); let n = 0; for (const e of actual.estancias) for (const f of e.fotos) numFoto.set(f, ++n); }
  function pintarEstancias() {
    numerarFotos();
    const abiertas = new Set([...document.querySelectorAll(".estancia[open]")].map(d => d.dataset.id));
    $("estancias").innerHTML = actual.estancias.map((e, i) => `
      <details class="estancia" data-id="${e.id}" ${abiertas.has(e.id) || i === actual.estancias.length - 1 ? "open" : ""}>
        <summary>▸ ${esc(e.nombre)}<span class="cuenta">${e.fotos.length} fotos · ${e.medidas.length} medidas</span></summary>
        <div class="cuerpo">
          <label>Nombre de la estancia<input class="nombre-est" data-campo="nombre" data-est="${e.id}" value="${esc(e.nombre)}"></label>
          <div class="fotos">${e.fotos.map(f => `<div class="foto"><img data-blob="${f}" alt=""><span class="n">${numFoto.get(f)}</span><button class="x" data-borrafoto="${f}" data-est="${e.id}" type="button" aria-label="Borrar foto">✕</button></div>`).join("")}</div>
          <div class="foto-btns"><button class="btn primary" data-camara="${e.id}" type="button">📷 Hacer foto</button><button class="btn" data-galeria="${e.id}" type="button">🖼 Galería</button></div>
          <label>Daños y notas</label>
          <div class="dictado"><textarea rows="3" data-campo="notas" data-est="${e.id}" placeholder="Dicta o escribe: «fisura en pared del salón de 1,20 metros lineales, pintura 3,20 por 2,50»">${esc(e.notas)}</textarea>
          <button class="mic" type="button" data-dictar-est="${e.id}" aria-label="Dictar">🎤</button></div>
          <div class="medidas">${e.medidas.map(m => medidaHTML(e, m)).join("")}</div>
          <div class="est-acciones">
            <button class="btn small" data-addmedida="${e.id}" type="button">＋ Medida</button>
            <button class="btn small" data-detectar="${e.id}" type="button">🔎 Medidas del dictado</button>
            <button class="link-danger" style="margin:0 0 0 auto" data-borraest="${e.id}" type="button">Borrar estancia</button>
          </div>
        </div>
      </details>`).join("");
    $("estancias").insertAdjacentHTML("beforeend", `<datalist id="dlConceptos">${CONCEPTOS.map(c => `<option value="${c}">`).join("")}</datalist>`);
    cargarMiniaturas();
  }
  function medidaHTML(e, m) {
    const at = `data-est="${e.id}" data-med="${m.id}"`;
    const area = m.unidad === "m²", ud = m.unidad === "ud";
    return `<div class="medida">
      <div class="cab"><label>Concepto<input list="dlConceptos" data-mcampo="concepto" ${at} value="${esc(m.concepto)}"></label>
        <label>Unidad<select data-mcampo="unidad" ${at}>${["m²", "ml", "ud"].map(u => `<option ${u === m.unidad ? "selected" : ""}>${u}</option>`).join("")}</select></label>
        <button class="del" data-borramed="${m.id}" data-est="${e.id}" type="button" aria-label="Borrar medida">✕</button></div>
      <div class="g">${ud ? `<label>Cantidad<input inputmode="decimal" data-mcampo="cantidad" ${at} value="${esc(m.cantidad)}"></label>`
        : `<label>${area ? "Largo (m)" : "Longitud (m)"}<input inputmode="decimal" data-mcampo="largo" ${at} value="${esc(m.largo)}"></label>`
        + (area ? `<label>Alto (m)<input inputmode="decimal" data-mcampo="alto" ${at} value="${esc(m.alto)}"></label><label>Descontar m²<input inputmode="decimal" data-mcampo="descuento" ${at} value="${esc(m.descuento)}" placeholder="huecos"></label>` : "")}</div>
      <div class="res">= <b data-res="${m.id}">${fmt(cantidad(m))} ${m.unidad}</b>
        <label><input type="checkbox" data-mcampo="estimada" ${at} ${m.estimada ? "checked" : ""}> estimada</label></div>
    </div>`;
  }
  function cantidad(m) {
    if (m.unidad === "ud") return num(m.cantidad);
    if (m.unidad === "ml") return num(m.largo);
    return Math.max(0, num(m.largo) * num(m.alto) - num(m.descuento));
  }
  const urls = [];
  async function cargarMiniaturas() {
    urls.splice(0).forEach(u => URL.revokeObjectURL(u));
    for (const img of document.querySelectorAll("img[data-blob]")) {
      const b = await blobGet(img.dataset.blob).catch(() => null);
      if (b) { const u = URL.createObjectURL(b.blob); urls.push(u); img.src = u; }
    }
  }
  const est = id => actual.estancias.find(e => e.id === id);
  function marcarEnCurso() { if (actual.estado === "pendiente" || actual.estado === "terminada") actual.estado = "en_curso"; }
  function addEstancia(nombre) {
    const iguales = actual.estancias.filter(e => e.nombre.startsWith(nombre)).length;
    actual.estancias.push({ id: uid(), nombre: iguales ? `${nombre} ${iguales + 1}` : nombre, fotos: [], notas: "", medidas: [] });
    marcarEnCurso(); guardar(); pintarEstancias(); pintarFin();
    document.querySelector(".estancia:last-of-type")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  async function addFotos(files) {
    const e = est(fotoEstancia);
    if (!e || !files.length) return;
    progreso(`Guardando ${files.length} foto(s)…`);
    try {
      for (const file of files) {
        const id = uid();
        await blobPut(id, file, file.name || "foto.jpg");
        e.fotos.push(id);
      }
      marcarEnCurso(); await guardar();
    } catch (err) { toast("⚠ No se guardó la foto: " + err.message, 8000); }
    finally { progreso(""); }
    pintarEstancias(); pintarFin();
  }

  // ---------- Dictado ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function pararDictado() { if (rec) { try { rec.stop(); } catch { } } }
  function dictar(textarea, btn) {
    if (rec) { pararDictado(); return; }
    if (!SR) { toast("Este navegador no dicta: pulsa el 🎤 del teclado.", 5000); textarea.focus(); return; }
    rec = new SR(); rec.lang = "es-ES"; rec.continuous = true; rec.interimResults = false;
    rec.onresult = ev => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) if (ev.results[i].isFinal) {
        const t = ev.results[i][0].transcript.trim();
        if (t) { textarea.value = (textarea.value.trim() ? textarea.value.trim() + ". " : "") + t.charAt(0).toUpperCase() + t.slice(1); textarea.dispatchEvent(new Event("input", { bubbles: true })); }
      }
    };
    rec.onerror = ev => { if (ev.error !== "no-speech" && ev.error !== "aborted") toast("Dictado: " + (ev.error === "not-allowed" ? "permite el micrófono" : ev.error) + ". Puedes usar el 🎤 del teclado.", 5000); };
    rec.onend = () => { rec = null; document.querySelectorAll(".mic.rec").forEach(b => b.classList.remove("rec")); };
    try { rec.start(); btn.classList.add("rec"); toast("Escuchando… pulsa otra vez el 🎤 para parar."); }
    catch { rec = null; toast("No se pudo iniciar el dictado. Usa el 🎤 del teclado."); }
  }
  // «3,20 por 2,50» → m²; «1,20 metros lineales» → ml. El concepto son las palabras previas.
  function detectarMedidas(texto) {
    const N = "(\\d+(?:[.,]\\d+)?)", out = [];
    const frases = texto.split(/[.;\n]+/);
    for (const fr of frases) {
      const reA = new RegExp(N + "\\s*(?:m(?:etros?)?\\s*)?(?:x|por|\\*)\\s*" + N, "gi");
      let m, usado = false;
      while ((m = reA.exec(fr))) {
        out.push({ concepto: conceptoDe(fr.slice(0, m.index)), unidad: "m²", largo: m[1].replace(".", ","), alto: m[2].replace(".", ",") });
        usado = true;
      }
      const reL = new RegExp(N + "\\s*(?:ml\\b|m\\.?\\s*l\\.?|metros? lineales?)", "gi");
      while ((m = reL.exec(fr))) out.push({ concepto: conceptoDe(fr.slice(0, m.index)), unidad: "ml", largo: m[1].replace(".", ",") });
      if (!usado) {
        const reS = new RegExp(N + "\\s*(?:m2|m²|metros? cuadrados?)", "gi");
        while ((m = reS.exec(fr))) out.push({ concepto: conceptoDe(fr.slice(0, m.index)), unidad: "m²", largo: m[1].replace(".", ","), alto: "1" });
      }
    }
    return out;
  }
  function conceptoDe(t) {
    const c = t.split(/,|\by\b/).pop().replace(/\b(de|del|con|en|unos|unas|mide|tiene|aprox(?:imadamente)?)\s*$/i, "").trim();
    return c ? c.charAt(0).toUpperCase() + c.slice(1, 60) : "";
  }

  // ---------- Firma ----------
  const cv = $("cvFirma");
  let trazos = 0;
  function prepararLienzo() {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    const c = cv.getContext("2d"); c.scale(dpr, dpr); c.lineWidth = 2.6; c.lineCap = "round"; c.lineJoin = "round"; c.strokeStyle = "#000";
    trazos = 0;
  }
  let dibujando = false;
  cv.addEventListener("pointerdown", e => { dibujando = true; cv.setPointerCapture(e.pointerId); const c = cv.getContext("2d"), r = cv.getBoundingClientRect(); c.beginPath(); c.moveTo(e.clientX - r.left, e.clientY - r.top); });
  cv.addEventListener("pointermove", e => { if (!dibujando) return; const c = cv.getContext("2d"), r = cv.getBoundingClientRect(); c.lineTo(e.clientX - r.left, e.clientY - r.top); c.stroke(); trazos++; });
  const fin = () => { dibujando = false; };
  cv.addEventListener("pointerup", fin); cv.addEventListener("pointercancel", fin);
  function abrirFirma() {
    const f = $("fFirma");
    f.asegurado.value = actual.inicio?.asegurado || actual.nombre;
    f.firmante.value = actual.inicio?.firmante || "";
    f.dni.value = actual.inicio?.dni || "";
    f.fecha.value = hoyISO();
    $("firmaResumen").textContent = `Nº tramitación 2026 / 18 / ${actual.exp} / 01`;
    $("dlgFirma").showModal();
    requestAnimationFrame(prepararLienzo);
  }
  // Recorta el lienzo a la firma y lo pasa a PNG.
  async function firmaPng() {
    const c = cv.getContext("2d"), { width: w, height: h } = cv, d = c.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 <= x0 || y1 <= y0) return null;
    const pad = 6, o = document.createElement("canvas");
    o.width = x1 - x0 + 2 * pad; o.height = y1 - y0 + 2 * pad;
    o.getContext("2d").drawImage(cv, x0 - pad, y0 - pad, o.width, o.height, 0, 0, o.width, o.height);
    const b = await new Promise(r => o.toBlob(r, "image/png"));
    return new Uint8Array(await b.arrayBuffer());
  }
  async function guardarFirma() {
    const f = $("fFirma");
    if (trazos < 8) { toast("Falta la firma."); return false; }
    const png = await firmaPng();
    if (!png) { toast("Falta la firma."); return false; }
    const datos = { exp: actual.exp, asegurado: f.asegurado.value.trim(), fecha: f.fecha.value, firmante: f.firmante.value.trim(), dni: f.dni.value.trim().toUpperCase() };
    const pdf = await RPPdf.inicioPeritacion({ ...datos, firmaPng: png });
    const pdfId = uid(), pngId = uid();
    await blobPut(pdfId, new Blob([pdf], { type: "application/pdf" }), "inicio.pdf");
    await blobPut(pngId, new Blob([png], { type: "image/png" }), "firma.png");
    if (actual.inicio) { blobDel(actual.inicio.pdfId).catch(() => { }); blobDel(actual.inicio.pngId).catch(() => { }); }
    actual.inicio = { ...datos, pdfId, pngId, at: new Date().toISOString() };
    marcarEnCurso(); await guardar();
    toast("Inicio de Peritación firmado y guardado.");
    pintarVisita();
    return true;
  }

  // ---------- Paquete ----------
  const ymd = iso => iso.replaceAll("-", "");
  async function sha256(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join(""); }
  function ext(b) { const t = b.blob.type || ""; if (t.includes("png")) return "png"; if (t.includes("heic")) return "heic"; if (t.includes("heif")) return "heif"; if (t.includes("webp")) return "webp"; const m = /\.(\w{2,5})$/.exec(b.name || ""); return m ? m[1].toLowerCase() : "jpg"; }
  async function prepararPaquete() {
    pararDictado();
    const v = actual;
    await guardar();
    const nFotos = v.estancias.reduce((s, e) => s + e.fotos.length, 0);
    if (!v.inicio && !confirm("El Inicio de Peritación NO está firmado. ¿Preparar el paquete igualmente?")) return;
    if (!nFotos && !confirm("No hay fotos. ¿Preparar el paquete igualmente?")) return;
    const fecha = v.inicio?.fecha || hoyISO();
    v.fechaVisita = fecha;
    const quien = perito || v.perito || "Perito";
    try {
      progreso("Reuniendo fotos…");
      numerarFotos();
      const entradas = [], fotos = [], fotosJson = [];
      for (const e of v.estancias) for (const fid of e.fotos) {
        const b = await blobGet(fid);
        if (!b) continue;
        const n = numFoto.get(fid), data = new Uint8Array(await b.blob.arrayBuffer());
        const nombre = `Fotografias/${String(n).padStart(3, "0")}_${slug(e.nombre)}.${ext(b)}`;
        entradas.push({ name: nombre, data });
        fotos.push({ n, estancia: e.nombre, blob: b.blob });
        fotosJson.push({ foto: n, estancia: e.nombre, archivo: nombre.replace("/", "\\"), original: b.name, sha256: await sha256(data) });
      }
      const medidas = [];
      for (const e of v.estancias) for (const m of e.medidas) {
        const c = cantidad(m);
        medidas.push({ estancia: e.nombre, concepto: m.concepto || "(sin concepto)", unidad: m.unidad, cantidad: Math.round(c * 100) / 100, cantidadTxt: fmt(c),
          detalle: m.unidad === "m²" ? `${m.largo || 0} × ${m.alto || 0}${num(m.descuento) ? ` − ${m.descuento}` : ""}` : m.unidad === "ml" ? `${m.largo || 0} m` : "",
          largo: num(m.largo), alto: num(m.alto), descuento: num(m.descuento), estimada: !!m.estimada, fotos: e.fotos.map(f => numFoto.get(f)) });
      }
      progreso("Generando reportaje PDF…");
      const rep = await RPPdf.reportaje({ visita: v, perito: quien, fotos, medidas, onProgress: (i, n) => progreso(`Generando reportaje PDF… foto ${i + 1} de ${n}`) });
      const base = `${v.exp}`;
      entradas.push({ name: `Reportaje_fotografico_${base}_visita_${ymd(fecha)}.pdf`, data: rep });
      if (v.inicio) {
        const ini = await blobGet(v.inicio.pdfId);
        entradas.push({ name: `InicioPer_202618${v.exp.padStart(5, "0")}01_firmado_${ymd(v.inicio.fecha)}.pdf`, data: new Uint8Array(await ini.blob.arrayBuffer()) });
      }
      const datos = {
        expediente: v.exp, fecha_visita: fecha, perito: quien, asegurado: v.nombre,
        riesgo: [v.direccion, v.municipio].filter(Boolean).join(", "), telefonos: v.telefonos,
        fuente: { tipo: "app RutaPerito v2", generado: new Date().toISOString() },
        inicio_peritacion: v.inicio ? { firmado: true, fecha: v.inicio.fecha, asegurado_en_documento: v.inicio.asegurado, firmante: v.inicio.firmante, dni: v.inicio.dni } : { firmado: false },
        estancias: v.estancias.map(e => ({ nombre: e.nombre, notas: e.notas, fotos: e.fotos.map(f => numFoto.get(f)) })),
        mediciones: medidas.map(({ cantidadTxt, ...m }) => m),
        observaciones: v.observaciones || "",
        fotografias: fotosJson
      };
      entradas.push({ name: `Datos_visita_y_mediciones_${base}_${ymd(fecha)}.json`, data: new TextEncoder().encode(JSON.stringify(datos, null, 2)) });
      progreso("Empaquetando…");
      const zip = RPZip.makeZip(entradas);
      const nombre = `Visita_${v.exp}_${ymd(fecha)}_${slug(quien)}.zip`;
      paquete = new File([zip], nombre, { type: "application/zip" });
      v.envios = [...(v.envios || []), { at: new Date().toISOString(), nombre, fotos: fotos.length, confirmado: false }];
      await guardar();
      $("envioResumen").textContent = `${nombre} · ${fotos.length} fotos · ${medidas.length} medidas · ${(zip.size / 1048576).toFixed(1)} MB${v.inicio ? " · Inicio firmado" : " · SIN Inicio firmado"}`;
      progreso("");
      $("dlgEnvio").showModal();
    } catch (err) {
      progreso(""); toast("⚠ Error preparando el paquete: " + err.message, 9000); console.error(err);
    }
  }
  function descargar(file) {
    const a = document.createElement("a"), u = URL.createObjectURL(file);
    a.href = u; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  }
  async function compartir() {
    if (!paquete) return;
    if (navigator.canShare?.({ files: [paquete] })) {
      try { await navigator.share({ files: [paquete], title: paquete.name }); toast("Cuando OneDrive termine de subirlo, pulsa «Ya está guardado».", 6000); return; }
      catch (e) { if (e.name === "AbortError") return; }
    }
    descargar(paquete);
    toast("Este navegador no permite compartir: se ha descargado. Súbelo a OneDrive desde Descargas.", 7000);
  }
  async function confirmarEnvio() {
    const u = actual.envios[actual.envios.length - 1];
    if (u) u.confirmado = true;
    actual.estado = "terminada";
    await guardar();
    $("dlgEnvio").close(); paquete = null;
    toast("Visita marcada como enviada ✓");
    pintarVisita();
  }

  async function borrarVisita(v) {
    const ids = v.estancias.flatMap(e => e.fotos).concat(v.inicio ? [v.inicio.pdfId, v.inicio.pngId] : []);
    for (const id of ids) await blobDel(id).catch(() => { });
    await dbDel(v.id);
    visitas = visitas.filter(x => x.id !== v.id);
  }

  // ---------- Eventos ----------
  document.addEventListener("click", async ev => {
    const t = ev.target.closest("button, [data-abrir]");
    if (!t) return;
    const d = t.dataset;
    if (d.abrir) return abrir(d.abrir);
    if (d.estancia) return addEstancia(d.estancia);
    if (d.camara || d.galeria) { fotoEstancia = d.camara || d.galeria; const inp = $(d.camara ? "inCamara" : "inGaleria"); inp.value = ""; return inp.click(); }
    if (d.borrafoto) {
      if (!confirm("¿Borrar esta foto?")) return;
      const e = est(d.est); e.fotos = e.fotos.filter(f => f !== d.borrafoto); await guardar(); blobDel(d.borrafoto).catch(() => { });
      pintarEstancias(); return pintarFin();
    }
    if (d.addmedida) { est(d.addmedida).medidas.push({ id: uid(), concepto: "", unidad: "m²", largo: "", alto: "", descuento: "", cantidad: "", estimada: false }); guardar(); return pintarEstancias(); }
    if (d.borramed) { const e = est(d.est); e.medidas = e.medidas.filter(m => m.id !== d.borramed); guardar(); return pintarEstancias(); }
    if (d.detectar) {
      const e = est(d.detectar), enc = detectarMedidas(e.notas || "");
      if (!enc.length) return toast("No encuentro medidas en el texto. Di por ejemplo «pintura 3,20 por 2,50» o «fisura 1,20 metros lineales».", 7000);
      if (!confirm(`Añadir ${enc.length} medida(s):\n` + enc.map(m => `• ${m.concepto || "(sin concepto)"}: ${m.unidad === "m²" ? m.largo + " × " + m.alto + " m²" : m.largo + " ml"}`).join("\n"))) return;
      enc.forEach(m => e.medidas.push({ id: uid(), descuento: "", cantidad: "", alto: "", estimada: false, ...m }));
      guardar(); return pintarEstancias();
    }
    if (d.borraest) {
      const e = est(d.borraest);
      if (!confirm(`¿Borrar «${e.nombre}» con sus ${e.fotos.length} fotos y ${e.medidas.length} medidas?`)) return;
      actual.estancias = actual.estancias.filter(x => x !== e); await guardar(); e.fotos.forEach(f => blobDel(f).catch(() => { }));
      pintarEstancias(); return pintarFin();
    }
    if (d.dictarEst) return dictar(document.querySelector(`textarea[data-est="${d.dictarEst}"]`), t);
    if (d.dictar) return dictar($(d.dictar), t);
    if (d.perito) { perito = d.perito; localStorage.setItem("rp-perito", perito); $("dlgAjustes").close(); return pintarHoy(); }
  });
  document.addEventListener("input", ev => {
    const t = ev.target, d = t.dataset;
    if (!actual) return;
    if (d.campo && d.est) { est(d.est)[d.campo] = t.value; if (d.campo === "nombre") t.closest("details").querySelector("summary").firstChild.textContent = "▸ " + t.value; return guardarLuego(); }
    if (d.mcampo) {
      const m = est(d.est).medidas.find(x => x.id === d.med);
      m[d.mcampo] = t.type === "checkbox" ? t.checked : t.value;
      if (d.mcampo === "unidad") { guardar(); return pintarEstancias(); }
      const r = document.querySelector(`[data-res="${m.id}"]`); if (r) r.textContent = `${fmt(cantidad(m))} ${m.unidad}`;
      return guardarLuego();
    }
    if (t.id === "obs") { actual.observaciones = t.value; guardarLuego(); }
  });
  document.addEventListener("change", ev => { if (ev.target.dataset.mcampo === "unidad" || ev.target.type === "checkbox") ev.target.dispatchEvent(new Event("input", { bubbles: true })); });

  $("inCamara").addEventListener("change", e => addFotos([...e.target.files]));
  $("inGaleria").addEventListener("change", e => addFotos([...e.target.files]));
  $("inAgenda").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) importarAgenda(f).catch(err => toast("⚠ Agenda no válida: " + err.message, 7000)); });
  $("diaPrev").onclick = () => { const d = new Date(dia + "T12:00:00"); d.setDate(d.getDate() - 1); dia = hoyISO(d); pintarHoy(); };
  $("diaNext").onclick = () => { const d = new Date(dia + "T12:00:00"); d.setDate(d.getDate() + 1); dia = hoyISO(d); pintarHoy(); };
  $("diaHoy").onclick = () => { dia = hoyISO(); pintarHoy(); };
  $("verTodas").onchange = pintarHoy;
  $("btnRuta").onclick = rutaDelDia;
  $("btnVolver").onclick = () => history.back();
  window.addEventListener("popstate", () => { if (actual) cerrarVisita(); });
  $("btnPerito").onclick = $("btnAjustes").onclick = async () => {
    const e = await navigator.storage?.estimate?.().catch(() => null);
    $("almacen").textContent = `${visitas.length} visitas en este móvil` + (e ? ` · ${(e.usage / 1048576).toFixed(0)} MB usados` : "");
    $("dlgAjustes").showModal();
  };
  $("btnCerrarAjustes").onclick = () => $("dlgAjustes").close();
  $("btnLimpiar").onclick = async () => {
    const env = visitas.filter(v => v.estado === "terminada" && v.envios?.some(x => x.confirmado));
    if (!env.length) return toast("No hay visitas enviadas que borrar.");
    if (!confirm(`¿Borrar del móvil ${env.length} visita(s) ya guardadas en OneDrive? Comprueba antes que están en el expediente.`)) return;
    for (const v of env) await borrarVisita(v);
    toast(`${env.length} visitas borradas del móvil.`); $("dlgAjustes").close(); pintarHoy();
  };

  function abrirDatos(v) {
    const f = $("fDatos");
    $("dlgDatosTitulo").textContent = v ? `Datos · ${v.exp}` : "Nueva visita";
    f.reset();
    const o = v || { fecha: dia, perito };
    for (const k of ["exp", "nombre", "direccion", "municipio", "fecha", "hora", "perito", "notas"]) f[k].value = o[k] || "";
    f.telefonos.value = (o.telefonos || []).join(" / ");
    f.dataset.id = v?.id || "";
    $("dlgDatos").showModal();
  }
  $("btnNueva").onclick = () => abrirDatos(null);
  $("btnEditar").onclick = () => abrirDatos(actual);
  $("dlgDatos").addEventListener("close", async () => {
    const f = $("fDatos");
    if ($("dlgDatos").returnValue !== "ok") return;
    const datos = filaAgenda({ exp: f.exp.value, nombre: f.nombre.value, direccion: f.direccion.value, municipio: f.municipio.value, telefonos: f.telefonos.value, fecha: f.fecha.value, hora: f.hora.value, perito: f.perito.value, notas: f.notas.value });
    if (!datos) return;
    let v = visitas.find(x => x.id === f.dataset.id);
    if (v) Object.assign(v, datos); else { v = nuevaVisita(datos); visitas.push(v); }
    await guardar(v);
    if (actual) pintarVisita(); else { if (v.fecha) dia = v.fecha; pintarHoy(); }
  });
  $("btnFirmar").onclick = abrirFirma;
  $("btnLimpiarFirma").onclick = prepararLienzo;
  $("fFirma").addEventListener("submit", async ev => {
    if (ev.submitter?.value !== "ok") return;
    ev.preventDefault();
    try { if (await guardarFirma()) $("dlgFirma").close(); } catch (e) { toast("⚠ Error guardando la firma: " + e.message, 8000); }
  });
  $("btnAcabar").onclick = prepararPaquete;
  $("btnCompartir").onclick = compartir;
  $("btnDescargar").onclick = () => paquete && descargar(paquete);
  $("btnEnviado").onclick = confirmarEnvio;
  $("btnCerrarEnvio").onclick = () => { $("dlgEnvio").close(); pintarFin(); };
  $("btnBorrarVisita").onclick = async () => {
    if (!confirm(`¿Borrar del móvil la visita ${actual.exp} con todas sus fotos y la firma? No se puede deshacer.`)) return;
    const v = actual; actual = null; await borrarVisita(v); history.back(); $("vVisita").hidden = true; $("vHoy").hidden = false; pintarHoy();
  };
  document.addEventListener("visibilitychange", () => { if (document.hidden && actual) { clearTimeout(saveTimer); guardar().catch(() => { }); } });

  // ---------- Arranque ----------
  (async () => {
    navigator.storage?.persist?.().catch(() => { });
    if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => { });
    visitas = await dbVisitas();
    pintarHoy();
    if (!perito) $("btnAjustes").click();
  })();
  window.RP = { detectarMedidas, filaAgenda, paquete: () => paquete }; // para pruebas
})();
