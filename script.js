/* =============================================================
   Calleando CABA — lógica principal
   - Inicializa Leaflet con CartoDB Positron
   - Carga data/calles.json (generado por build_data.py)
   - Autocomplete contra ese dataset
   - Geocoding en vivo contra Nominatim + cache localStorage
   - Dibuja polyline (calles) o marker (plazas/parques) según tipo
   ============================================================= */

(() => {
    "use strict";

    // ---------- Configuración ----------
    const CABA_CENTER = [-34.6037, -58.3816];
    const CABA_BOUNDS = [
        [-34.706, -58.531],   // SW
        [-34.527, -58.335],   // NE
    ];
    const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
    const VIEWBOX = "-58.531,-34.706,-58.335,-34.527"; // long/lat, long/lat
    const CACHE_KEY = "calleando_geocache_v1";
    const MAX_SUGGESTIONS = 8;
    const LINE_COLOR = "#1a73e8";

    // Tipos que se dibujan como línea (calles); el resto como marcador.
    const TIPOS_LINEA = new Set([
        "calle", "avenida", "pasaje peatonal", "autopista",
        "sendero", "paseo", "puente", "túnel", "tunel",
        "sendero peatonal", "puente peatonal",
    ]);

    // ---------- Estado ----------
    let calles = [];               // array cargado desde calles.json
    let geoCache = {};             // {clave: {tipo, geometry, bbox, ...}} pre-geocodificado
    let mapa;                      // instancia Leaflet
    let capaActual = null;         // polyline o marker dibujado por la última búsqueda
    let popupActual = null;        // popup actual
    let indiceActivo = -1;         // sugerencia resaltada con teclado

    // ---------- DOM ----------
    const $input = document.getElementById("search-input");
    const $btnBuscar = document.getElementById("search-btn");
    const $btnLimpiar = document.getElementById("clear-btn");
    const $suggestions = document.getElementById("suggestions");
    const $toast = document.getElementById("status-toast");

    // =================================================================
    // 1. UTILIDADES
    // =================================================================

    /** Quita tildes, pasa a minúsculas, normaliza espacios. */
    function normalizar(texto) {
        if (!texto) return "";
        return texto
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .replace(/[^\w\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function esTipoLinea(tipo) {
        return TIPOS_LINEA.has((tipo || "").toLowerCase().trim());
    }

    function mostrarToast(mensaje, duracionMs = 3000) {
        $toast.textContent = mensaje;
        $toast.hidden = false;
        clearTimeout(mostrarToast._t);
        mostrarToast._t = setTimeout(() => { $toast.hidden = true; }, duracionMs);
    }

    function escapeHtml(s) {
        return String(s || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    // =================================================================
    // 2. CACHE DE GEOCODING (localStorage)
    // =================================================================

    function leerCache() {
        try {
            return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
        } catch (_) {
            return {};
        }
    }

    function guardarEnCache(clave, valor) {
        try {
            const cache = leerCache();
            cache[clave] = valor;
            localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
        } catch (_) {
            // localStorage lleno: silencioso
        }
    }

    // =================================================================
    // 3. INICIALIZACIÓN DEL MAPA
    // =================================================================

    function inicializarMapa() {
        mapa = L.map("map", {
            center: CABA_CENTER,
            zoom: 13,
            zoomControl: true,
            maxBounds: [
                [-34.85, -58.75],
                [-34.40, -58.10],
            ],
            minZoom: 11,
            maxZoom: 19,
        });

        // Estética clara estilo Google Maps
        L.tileLayer(
            "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
            {
                attribution: "",
                subdomains: "abcd",
                maxZoom: 19,
            }
        ).addTo(mapa);

        // Reposicionar el control de zoom para no chocar con la caja de búsqueda
        mapa.zoomControl.setPosition("bottomright");
    }

    // =================================================================
    // 4. CARGA DE DATOS
    // =================================================================

    async function cargarDatos() {
        // Carga en paralelo: el dataset principal y el cache pre-geocodificado.
        // Si geo_cache.json no existe (todavía no se corrió la Fase 2), se sigue
        // funcionando con geocoding en vivo contra Nominatim.
        const [respCalles, respCache] = await Promise.all([
            fetch("data/calles.json"),
            fetch("data/geo_cache.json").catch(() => null),
        ]);

        if (!respCalles || !respCalles.ok) {
            console.error("Error cargando calles.json");
            mostrarToast("No se pudieron cargar los datos del Excel.", 6000);
            return;
        }
        calles = await respCalles.json();
        console.log(`Datos cargados: ${calles.length} entradas`);

        if (respCache && respCache.ok) {
            try {
                geoCache = await respCache.json();
                console.log(`Geo-cache pre-cargado: ${Object.keys(geoCache).length} geometrías`);
            } catch (_) {
                geoCache = {};
            }
        } else {
            console.log("Sin geo-cache pre-generado — usando modo en vivo.");
        }
    }

    // =================================================================
    // 5. AUTOCOMPLETE
    // =================================================================

    function buscarSugerencias(consulta) {
        const q = normalizar(consulta);
        if (q.length < 2) return [];

        // Prioridad: coincidencias al inicio, luego "contiene".
        const empiezan = [];
        const contienen = [];
        for (const c of calles) {
            if (!c.clave) continue;
            if (c.clave.startsWith(q)) {
                empiezan.push(c);
            } else if (c.clave.includes(q)) {
                contienen.push(c);
            }
            if (empiezan.length >= MAX_SUGGESTIONS) break;
        }

        return empiezan.concat(contienen).slice(0, MAX_SUGGESTIONS);
    }

    function renderSugerencias(items) {
        $suggestions.innerHTML = "";
        indiceActivo = -1;

        if (items.length === 0) {
            $suggestions.hidden = true;
            return;
        }

        for (const item of items) {
            const li = document.createElement("li");
            li.setAttribute("role", "option");
            li.dataset.clave = item.clave;
            li.innerHTML = `
                <span class="suggestion-title">${escapeHtml(item.nombre_busqueda)}</span>
                <span class="suggestion-sub">${escapeHtml(item.tipo || "")}${item.categoria ? " · " + escapeHtml(item.categoria.toLowerCase()) : ""}</span>
            `;
            li.addEventListener("click", () => seleccionarEntrada(item));
            $suggestions.appendChild(li);
        }
        $suggestions.hidden = false;
    }

    function moverIndice(delta) {
        const lis = $suggestions.querySelectorAll("li");
        if (lis.length === 0) return;

        if (indiceActivo >= 0 && lis[indiceActivo]) {
            lis[indiceActivo].classList.remove("active");
        }
        indiceActivo = (indiceActivo + delta + lis.length) % lis.length;
        lis[indiceActivo].classList.add("active");
        lis[indiceActivo].scrollIntoView({ block: "nearest" });
    }

    // =================================================================
    // 6. SELECCIÓN Y GEOCODING
    // =================================================================

    function seleccionarEntrada(entrada) {
        $input.value = entrada.nombre_busqueda;
        $suggestions.hidden = true;
        $btnLimpiar.hidden = false;
        ubicarEnMapa(entrada);
    }

    /** Busca por texto libre cuando el usuario aprieta el botón Buscar. */
    function buscarPorTexto() {
        const q = normalizar($input.value);
        if (!q) return;

        const exacta = calles.find((c) => c.clave === q);
        if (exacta) {
            ubicarEnMapa(exacta);
            $suggestions.hidden = true;
            return;
        }

        const sugerencias = buscarSugerencias($input.value);
        if (sugerencias.length > 0) {
            ubicarEnMapa(sugerencias[0]);
            $suggestions.hidden = true;
        } else {
            mostrarToast(`No encontramos "${$input.value}" en el listado.`);
        }
    }

    async function ubicarEnMapa(entrada) {
        limpiarCapa();
        mostrarToast("Buscando ubicación…", 8000);

        try {
            const resultado = await obtenerGeometria(entrada);
            if (!resultado) {
                mostrarToast(
                    `No pudimos ubicar "${entrada.nombre_busqueda}" en el mapa. ` +
                    `Puede no estar indexado en OpenStreetMap.`,
                    5000,
                );
                return;
            }

            dibujarResultado(entrada, resultado);
            // Ocultar toast en cuanto se dibuja
            $toast.hidden = true;
        } catch (err) {
            console.error(err);
            mostrarToast("Error al consultar el geocoder. Reintenta en unos segundos.", 4000);
        }
    }

    /**
     * Obtiene la geometría de una entrada.
     * Orden de prioridad:
     *   1. Geo-cache pre-generado (data/geo_cache.json — Fase 2, instantáneo)
     *   2. Cache del usuario en localStorage (búsquedas previas en este navegador)
     *   3. Consulta en vivo a Nominatim (fallback)
     * Devuelve { tipo: 'line'|'point', geometry: GeoJSON, bbox?, center? } o null.
     */
    async function obtenerGeometria(entrada) {
        // 1. Cache pre-generado por geocode_all.py
        if (geoCache[entrada.clave]) {
            return geoCache[entrada.clave];
        }

        // 2. Cache local del navegador (de búsquedas previas en vivo)
        const cache = leerCache();
        if (cache[entrada.clave]) {
            return cache[entrada.clave];
        }

        // Construcción de la query para Nominatim
        const params = new URLSearchParams({
            q: `${entrada.nombre_busqueda}, Ciudad Autónoma de Buenos Aires, Argentina`,
            format: "json",
            polygon_geojson: "1",
            addressdetails: "0",
            limit: "8",
            viewbox: VIEWBOX,
            bounded: "1",
            countrycodes: "ar",
        });

        const resp = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
            headers: { "Accept-Language": "es" },
        });
        if (!resp.ok) throw new Error("Nominatim HTTP " + resp.status);

        const data = await resp.json();
        if (!Array.isArray(data) || data.length === 0) {
            return null;
        }

        const preferenciaLinea = esTipoLinea(entrada.tipo);
        const mejor = elegirMejorResultado(data, preferenciaLinea);
        if (!mejor) return null;

        const geom = mejor.geojson;
        let resultado;

        if (preferenciaLinea && geom &&
            (geom.type === "LineString" || geom.type === "MultiLineString")) {
            resultado = {
                tipo: "line",
                geometry: geom,
                bbox: mejor.boundingbox,
            };
        } else {
            resultado = {
                tipo: "point",
                center: [parseFloat(mejor.lat), parseFloat(mejor.lon)],
                geometry: geom || null,
                bbox: mejor.boundingbox,
            };
        }

        guardarEnCache(entrada.clave, resultado);
        return resultado;
    }

    /**
     * De los resultados de Nominatim, elige el más adecuado.
     * Si preferimos línea, priorizamos LineString/MultiLineString en CABA.
     */
    function elegirMejorResultado(resultados, preferenciaLinea) {
        const enCaba = resultados.filter((r) => {
            const dn = (r.display_name || "").toLowerCase();
            return dn.includes("buenos aires") || dn.includes("caba");
        });
        const pool = enCaba.length > 0 ? enCaba : resultados;

        if (preferenciaLinea) {
            const lineas = pool.filter((r) =>
                r.geojson && (r.geojson.type === "LineString" || r.geojson.type === "MultiLineString")
            );
            if (lineas.length > 0) return lineas[0];
        }

        return pool[0];
    }

    // =================================================================
    // 7. DIBUJADO EN EL MAPA
    // =================================================================

    function limpiarCapa() {
        if (capaActual) {
            mapa.removeLayer(capaActual);
            capaActual = null;
        }
        if (popupActual) {
            mapa.closePopup(popupActual);
            popupActual = null;
        }
    }

    function dibujarResultado(entrada, resultado) {
        const popupHtml = construirPopup(entrada);

        if (resultado.tipo === "line") {
            // GeoJSON LineString/MultiLineString -> Polyline
            capaActual = L.geoJSON(resultado.geometry, {
                style: {
                    color: LINE_COLOR,
                    weight: 8,
                    opacity: 0.9,
                    lineCap: "round",
                    lineJoin: "round",
                },
            }).addTo(mapa);

            mapa.fitBounds(capaActual.getBounds(), {
                padding: [80, 80],
                maxZoom: 17,
            });

            // Abrir popup en el centro del bounds
            const centro = capaActual.getBounds().getCenter();
            popupActual = L.popup({
                offset: [0, -6],
                autoPan: true,
                className: "calleando-popup",
            })
                .setLatLng(centro)
                .setContent(popupHtml)
                .openOn(mapa);
        } else {
            // Marker para plazas, parques, etc.
            capaActual = L.marker(resultado.center, {
                title: entrada.nombre_busqueda,
            }).addTo(mapa);

            if (resultado.bbox) {
                const [latMin, latMax, lonMin, lonMax] = resultado.bbox.map(parseFloat);
                mapa.fitBounds([[latMin, lonMin], [latMax, lonMax]], {
                    padding: [80, 80],
                    maxZoom: 17,
                });
            } else {
                mapa.setView(resultado.center, 17);
            }

            popupActual = capaActual.bindPopup(popupHtml, {
                offset: [0, -10],
                className: "calleando-popup",
            }).openPopup();
        }
    }

    function construirPopup(entrada) {
        const subtitulo = [entrada.tipo, entrada.categoria && entrada.categoria.toLowerCase()]
            .filter(Boolean)
            .join(" · ");

        return `
            <div class="popup-title">${escapeHtml(entrada.nombre_busqueda)}</div>
            ${subtitulo ? `<div class="popup-sub">${escapeHtml(subtitulo)}</div>` : ""}
            ${entrada.descripcion ? `<div class="popup-desc">${escapeHtml(entrada.descripcion)}</div>` : ""}
        `;
    }

    // =================================================================
    // 8. EVENTOS DE UI
    // =================================================================

    function conectarEventos() {
        // Tipeo en el input -> autocomplete
        $input.addEventListener("input", () => {
            const valor = $input.value;
            $btnLimpiar.hidden = valor.length === 0;
            const sugerencias = buscarSugerencias(valor);
            renderSugerencias(sugerencias);
        });

        // Teclas: Enter, flechas, Escape
        $input.addEventListener("keydown", (e) => {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                moverIndice(1);
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                moverIndice(-1);
            } else if (e.key === "Enter") {
                e.preventDefault();
                const lis = $suggestions.querySelectorAll("li");
                if (indiceActivo >= 0 && lis[indiceActivo]) {
                    const clave = lis[indiceActivo].dataset.clave;
                    const entrada = calles.find((c) => c.clave === clave);
                    if (entrada) {
                        seleccionarEntrada(entrada);
                        return;
                    }
                }
                buscarPorTexto();
            } else if (e.key === "Escape") {
                $suggestions.hidden = true;
            }
        });

        // Botón buscar
        $btnBuscar.addEventListener("click", buscarPorTexto);

        // Botón limpiar (cruz)
        $btnLimpiar.addEventListener("click", () => {
            $input.value = "";
            $btnLimpiar.hidden = true;
            $suggestions.hidden = true;
            limpiarCapa();
            mapa.flyTo(CABA_CENTER, 13, { duration: 0.6 });
            $input.focus();
        });

        // Cerrar sugerencias al click fuera
        document.addEventListener("click", (e) => {
            if (!e.target.closest(".search-box")) {
                $suggestions.hidden = true;
            }
        });

        // Reabrir sugerencias al volver al input
        $input.addEventListener("focus", () => {
            if ($input.value.length >= 2) {
                const sugerencias = buscarSugerencias($input.value);
                renderSugerencias(sugerencias);
            }
        });
    }

    // =================================================================
    // 9. ARRANQUE
    // =================================================================

    async function main() {
        inicializarMapa();
        await cargarDatos();
        conectarEventos();
    }

    document.addEventListener("DOMContentLoaded", main);
})();
