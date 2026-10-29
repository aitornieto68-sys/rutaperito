// PDFs de la visita: Inicio de Peritación firmado y reportaje fotográfico.
(function () {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const A4 = [595.28, 841.89];
  const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const WIN_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

  // Las fuentes estándar solo admiten WinAnsi: se sustituye lo demás.
  function win(text) {
    return String(text ?? "").replace(/[\t\r]/g, " ").split("").map(ch => {
      const c = ch.charCodeAt(0);
      if (ch === "\n" || (c >= 32 && c <= 126) || (c >= 160 && c <= 255) || WIN_EXTRA.includes(ch)) return ch;
      return "?";
    }).join("");
  }
  function fechaLarga(iso) {
    const [y, m, d] = iso.split("-");
    return `${d} de ${MESES[Number(m) - 1]} de ${y}`;
  }
  function wrap(text, font, size, width) {
    const lines = [];
    for (const para of win(text).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const test = line ? line + " " + word : word;
        if (font.widthOfTextAtSize(test, size) > width && line) { lines.push(line); line = word; }
        else line = test;
      }
      lines.push(line);
    }
    return lines;
  }
  function justified(page, text, font, size, x, y, width, leading, indent = 0) {
    const lines = wrap(text, font, size, width - indent);
    lines.forEach((line, i) => {
      const lx = x + (i === 0 ? indent : 0), lw = width - (i === 0 ? indent : 0);
      const words = line.split(" ");
      if (i === lines.length - 1 || words.length < 2) {
        page.drawText(line, { x: lx, y, size, font });
      } else {
        const wordsW = words.reduce((s, w) => s + font.widthOfTextAtSize(w, size), 0);
        const gap = (lw - wordsW) / (words.length - 1);
        let cx = lx;
        for (const w of words) { page.drawText(w, { x: cx, y, size, font }); cx += font.widthOfTextAtSize(w, size) + gap; }
      }
      y -= leading;
    });
    return y;
  }
  function centered(page, text, font, size, y) {
    const t = win(text);
    page.drawText(t, { x: (A4[0] - font.widthOfTextAtSize(t, size)) / 2, y, size, font });
  }

  // Réplica del Registro de Fecha de Inicio de Peritación del portal, con la fecha de la visita.
  async function inicioPeritacion({ exp, asegurado, fecha, firmaPng, firmante, dni }) {
    const doc = await PDFDocument.create();
    doc.setTitle(`Inicio de Peritación ${exp}`);
    const page = doc.addPage(A4);
    const f = await doc.embedFont(StandardFonts.Helvetica);
    const fb = await doc.embedFont(StandardFonts.HelveticaBold);
    const L = 113, W = 444, top = A4[1];
    page.drawText("Nº TRAMITACIÓN:", { x: L, y: top - 85, size: 9, font: fb });
    page.drawText(`2026 / 18 / ${exp} / 01`, { x: L + fb.widthOfTextAtSize("Nº TRAMITACIÓN:", 9) + 4, y: top - 85, size: 9, font: f });
    centered(page, "Registro de Fecha de Inicio de Peritación", fb, 10.5, top - 138);
    justified(page, `SAEPE INGENIERIA, S.L, Perito Tasador de Seguros, ha recibido el encargo del Consorcio de Compensación de Seguros de practicar las comprobaciones necesarias y recopilar todos los datos que se estimen más adecuados con el fin de analizar las causas del siniestro y valorar los daños sufridos en bienes de propiedad del Asegurado ${asegurado} en relación con el expediente señalado en cabecera.`, f, 9.2, L, top - 270, W, 11.2, 30);
    page.drawText(win("A tal fin, se persona hoy en el lugar del siniestro para iniciar su cometido."), { x: L + 30, y: top - 384, size: 9.2, font: f });
    centered(page, `GRANADA, ${fechaLarga(fecha)}`, f, 9.2, top - 466);
    centered(page, "EL ASEGURADO,", f, 9.2, top - 477);
    const img = await doc.embedPng(firmaPng);
    const maxW = 210, maxH = 110, s = Math.min(maxW / img.width, maxH / img.height);
    const w = img.width * s, h = img.height * s;
    page.drawImage(img, { x: (A4[0] - w) / 2, y: top - 490 - h, width: w, height: h });
    const pie = [firmante && `Fdo.: ${firmante}`, dni && `DNI: ${dni}`].filter(Boolean).join("   ·   ");
    if (pie) centered(page, pie, f, 8.5, top - 500 - h);
    return doc.save();
  }

  // Reduce la foto para el PDF respetando la orientación EXIF.
  async function fotoParaPdf(blob) {
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
    const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const out = await new Promise(r => c.toBlob(r, "image/jpeg", 0.82));
    return new Uint8Array(await out.arrayBuffer());
  }

  // visita: datos; fotos: [{n, estancia, blob}]; medidas: filas ya calculadas.
  async function reportaje({ visita, perito, fotos, medidas, onProgress }) {
    const doc = await PDFDocument.create();
    doc.setTitle(`Reportaje fotográfico ${visita.exp}`);
    const f = await doc.embedFont(StandardFonts.Helvetica);
    const fb = await doc.embedFont(StandardFonts.HelveticaBold);
    const M = 42, W = A4[0] - 2 * M, gris = rgb(0.4, 0.4, 0.4), linea = rgb(0.8, 0.8, 0.8);
    let page, y;
    const nueva = () => { page = doc.addPage(A4); y = A4[1] - M; };
    const texto = (t, size = 10, font = f, color) => {
      for (const l of wrap(t, font, size, W)) {
        if (y < M + size) nueva();
        page.drawText(l, { x: M, y: y - size, size, font, color });
        y -= size * 1.35;
      }
    };
    nueva();
    texto(`Reportaje fotográfico · Expediente ${visita.exp}`, 16, fb);
    y -= 4;
    texto(`Asegurado: ${visita.nombre || "-"}`);
    texto(`Riesgo: ${[visita.direccion, visita.municipio].filter(Boolean).join(", ") || "-"}`);
    texto(`Fecha de visita: ${fechaLarga(visita.fechaVisita)}   ·   Perito: ${perito}`);
    texto(`Fotografías: ${fotos.length}`, 10, f, gris);
    y -= 10;

    texto("Mediciones", 12, fb);
    if (!medidas.length) texto("Sin mediciones anotadas.", 10, f, gris);
    const cols = [M, M + 105, M + 290, M + 400, M + 470];
    const fila = (vals, font) => {
      const alto = Math.max(...vals.map((v, i) => wrap(v, font, 9, (cols[i + 1] || M + W) - cols[i] - 6).length)) * 11 + 4;
      if (y - alto < M) nueva();
      vals.forEach((v, i) => wrap(v, font, 9, (cols[i + 1] || M + W) - cols[i] - 6).forEach((l, k) => page.drawText(l, { x: cols[i], y: y - 10 - k * 11, size: 9, font })));
      y -= alto;
      page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: 0.5, color: linea });
    };
    if (medidas.length) {
      fila(["Estancia", "Concepto", "Medida", "Cantidad", "Fotos"], fb);
      for (const m of medidas) fila([m.estancia, m.concepto + (m.estimada ? " (estimada)" : ""), m.detalle, `${m.cantidadTxt} ${m.unidad}`, m.fotos.join(", ")], f);
    }
    y -= 10;
    for (const e of visita.estancias.filter(e => e.notas?.trim())) {
      texto(e.nombre, 10, fb);
      texto(e.notas, 9.5);
      y -= 4;
    }
    if (visita.observaciones?.trim()) { y -= 6; texto("Observaciones generales", 12, fb); texto(visita.observaciones, 9.5); }

    // Fotos: dos por página con su pie.
    const hueco = (A4[1] - 2 * M - 40) / 2;
    for (let i = 0; i < fotos.length; i++) {
      onProgress?.(i, fotos.length);
      if (i % 2 === 0) nueva();
      const ft = fotos[i];
      let img;
      try { img = await doc.embedJpg(await fotoParaPdf(ft.blob)); }
      catch { texto(`Foto ${ft.n} (${ft.estancia}): no se pudo leer en este móvil; el original va en la carpeta Fotografias.`, 9, f, gris); continue; }
      const s = Math.min(W / img.width, (hueco - 18) / img.height), w = img.width * s, h = img.height * s;
      const baseY = A4[1] - M - (i % 2) * (hueco + 20);
      page.drawImage(img, { x: M + (W - w) / 2, y: baseY - h, width: w, height: h });
      const pie = win(`Foto ${ft.n} · ${ft.estancia}`);
      page.drawText(pie, { x: M + (W - f.widthOfTextAtSize(pie, 9)) / 2, y: baseY - h - 13, size: 9, font: f, color: gris });
    }
    const pages = doc.getPages();
    pages.forEach((p, i) => { const t = `Exp. ${visita.exp} · ${i + 1}/${pages.length}`; p.drawText(t, { x: A4[0] - M - f.widthOfTextAtSize(t, 8), y: 22, size: 8, font: f, color: gris }); });
    return doc.save();
  }

  window.RPPdf = { inicioPeritacion, reportaje, fechaLarga };
})();
