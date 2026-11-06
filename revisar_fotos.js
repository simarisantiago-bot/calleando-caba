/* Hoja de contactos para revisar las fotos que la app resuelve por busqueda en
   vivo contra Wikipedia (las que NO tienen clave en data/fotos.json).

   Idea: el ~95% de esas fotos esta bien, asi que pedirle a alguien un veredicto
   por entrada es tirar el tiempo. Aca todo arranca "pendiente", se marcan solo
   las que estan mal, y al confirmar un bloque las pendientes pasan a correctas.
   Revisar de a bloques de 24 da ademas una nocion de avance y un lugar natural
   donde cortar.

   Entrada:  data/fotos_auditoria.json  (lo genera auditar_fotos.py)
   Salida:   revision_fotos.json        (lo baja el boton Exportar)
             lo aplica aplicar_revision.py
*/

(function () {
    "use strict";

    var POR_BLOQUE = 24;
    var LS_CLAVE = "calleando.revision.fotos.v1";

    var datos = [];
    var estados = {};          // {id: "mal" | "duda" | "ok"}  (ausente = pendiente)

    var $contenido = document.getElementById("contenido");
    var $pie = document.getElementById("pie");
    var $filtro = document.getElementById("filtro");
    var $subtitulo = document.getElementById("subtitulo");

    // ---------- persistencia ----------

    function cargarEstados() {
        try {
            var txt = localStorage.getItem(LS_CLAVE);
            estados = txt ? JSON.parse(txt) : {};
        } catch (_) {
            estados = {};          // modo privado, storage bloqueado, etc.
        }
    }

    function guardarEstados() {
        try {
            localStorage.setItem(LS_CLAVE, JSON.stringify(estados));
        } catch (_) { /* si no se puede guardar, la revision igual funciona */ }
    }

    // ---------- helpers ----------

    function esc(s) {
        return String(s === null || s === undefined ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function tipoDe(entrada) {
        var p = String(entrada.id || "").split("|");
        return p.length > 1 ? p[1] : "";
    }

    function etiquetaBandera(b) {
        return {
            NO_ES_PERSONA: "no es persona",
            OTRA_PERSONA: "otra persona",
            LUGAR_SIN_LUGAR: "no es un lugar",
            NO_DEBERIA_SER_LUGAR: "es un lugar",
            SIN_WIKIDATA: "sin wikidata"
        }[b] || b.toLowerCase().replace(/_/g, " ");
    }

    // ---------- armado de secciones ----------

    function secciones() {
        var modo = $filtro.value;
        var sosp = datos.filter(function (r) { return r.sospecha > 0; });
        var resto = datos.filter(function (r) { return r.sospecha === 0; });

        if (modo === "solo-sospechosas") {
            return [{
                titulo: "Sospechosas (" + sosp.length + ")",
                bajada: "Marcadas por los filtros automaticos de auditar_fotos.py.",
                items: sosp
            }];
        }
        if (modo === "pendientes") {
            var p = datos.filter(function (r) { return !estados[r.id]; });
            return [{ titulo: "Pendientes (" + p.length + ")", bajada: "", items: p }];
        }
        if (modo === "marcadas") {
            var m = datos.filter(function (r) {
                return estados[r.id] === "mal" || estados[r.id] === "duda";
            });
            return [{
                titulo: "Marcadas (" + m.length + ")",
                bajada: "Las que diste por incorrectas o dudosas.",
                items: m
            }];
        }

        var porCategoria = agrupar(modo === "sospechosas" ? resto : datos);
        if (modo === "todas") return porCategoria;

        return [{
            titulo: "Sospechosas (" + sosp.length + ")",
            bajada: "Los filtros automaticos las marcaron por incoherencia entre la " +
                    "entrada y el articulo del que sale la foto. Empeza por aca: es " +
                    "donde esta la mayor densidad de errores.",
            items: sosp
        }].concat(porCategoria);
    }

    function agrupar(lista) {
        var mapa = {};
        lista.forEach(function (r) {
            var c = r.categoria || "SIN CATEGORIA";
            (mapa[c] = mapa[c] || []).push(r);
        });
        return Object.keys(mapa)
            .sort(function (a, b) { return mapa[b].length - mapa[a].length; })
            .map(function (c) {
                return { titulo: c + " (" + mapa[c].length + ")", bajada: "", items: mapa[c] };
            });
    }

    // ---------- render ----------

    function tarjetaHTML(r) {
        var estado = estados[r.id] || "";
        var marca = { mal: "✕", duda: "?", ok: "✓" }[estado] || "";
        var tipos = (r.tipos || []).slice(0, 2).join(", ");
        var banderas = (r.banderas || [])
            .filter(function (b) { return b !== "OVERRIDE_MANUAL"; })
            .map(function (b) {
                return '<span class="bandera">' + esc(etiquetaBandera(b)) + "</span>";
            }).join("");

        return '<article class="tarjeta" data-id="' + esc(r.id) + '"' +
               (estado ? ' data-estado="' + estado + '"' : "") +
               ' title="' + esc(r.descripcion || "") + '">' +
               '<div class="marca">' + marca + "</div>" +
               '<img class="tarjeta-img" loading="lazy" referrerpolicy="no-referrer"' +
               ' alt="" src="' + esc(r.thumb) + '">' +
               '<div class="tarjeta-cuerpo">' +
                   '<div class="tarjeta-nombre">' + esc(r.nombre) + "</div>" +
                   '<div class="tarjeta-meta">' + esc(tipoDe(r)) +
                       (r.categoria ? " · " + esc(r.categoria.toLowerCase()) : "") +
                   "</div>" +
                   '<div class="tarjeta-art">foto de: <b>' + esc(r.titulo) + "</b>" +
                       (tipos ? " (" + esc(tipos) + ")" : "") + "</div>" +
                   (banderas ? '<div class="banderas">' + banderas + "</div>" : "") +
               "</div></article>";
    }

    function render() {
        var secs = secciones();
        var html = "";
        var nBloque = 0;

        secs.forEach(function (sec) {
            if (!sec.items.length) return;
            html += '<h2 class="seccion-titulo">' + esc(sec.titulo) + "</h2>";
            if (sec.bajada) html += '<p class="seccion-bajada">' + esc(sec.bajada) + "</p>";

            for (var i = 0; i < sec.items.length; i += POR_BLOQUE) {
                var trozo = sec.items.slice(i, i + POR_BLOQUE);
                var ids = trozo.map(function (r) { return r.id; });
                var pend = ids.filter(function (id) { return !estados[id]; }).length;
                nBloque++;

                html += '<section class="bloque' + (pend ? "" : " confirmado") + '"' +
                        ' data-ids="' + esc(JSON.stringify(ids)) + '">' +
                        '<div class="bloque-cab">' +
                            "<span>Bloque " + nBloque + " · " + trozo.length + " fotos" +
                            (pend ? " · " + pend + " pendientes" : " · revisado") +
                            "</span>" +
                            (pend ? '<button class="btn btn-fantasma js-confirmar">' +
                                    "✓ Las pendientes de este bloque estan bien</button>" : "") +
                        "</div>" +
                        '<div class="grilla">' + trozo.map(tarjetaHTML).join("") + "</div>" +
                        "</section>";
            }
        });

        $contenido.innerHTML = html ||
            '<p class="vacio">No hay entradas para este filtro.</p>';
        actualizarCuentas();
    }

    function actualizarCuentas() {
        var n = { mal: 0, duda: 0, ok: 0, pend: 0 };
        datos.forEach(function (r) {
            var e = estados[r.id];
            if (e === "mal") n.mal++;
            else if (e === "duda") n.duda++;
            else if (e === "ok") n.ok++;
            else n.pend++;
        });

        var decididas = datos.length - n.pend;
        var pct = datos.length ? (100 * decididas / datos.length) : 0;
        document.getElementById("progresoFill").style.width = pct + "%";
        document.getElementById("progresoTxt").textContent =
            decididas + " / " + datos.length;

        $pie.innerHTML =
            '<span class="cuenta"><i class="punto punto-mal"></i>Mal <b>' + n.mal + "</b></span>" +
            '<span class="cuenta"><i class="punto punto-duda"></i>Dudosas <b>' + n.duda + "</b></span>" +
            '<span class="cuenta"><i class="punto punto-ok"></i>Correctas <b>' + n.ok + "</b></span>" +
            '<span class="cuenta"><i class="punto punto-pend"></i>Pendientes <b>' + n.pend + "</b></span>" +
            '<span class="sutil" style="margin-left:auto">' +
                "click: mal → dudosa → pendiente</span>";
    }

    // ---------- interaccion ----------

    var CICLO = { "": "mal", mal: "duda", duda: "", ok: "mal" };

    $contenido.addEventListener("click", function (ev) {
        var btn = ev.target.closest(".js-confirmar");
        if (btn) {
            var bloque = btn.closest(".bloque");
            JSON.parse(bloque.dataset.ids).forEach(function (id) {
                if (!estados[id]) estados[id] = "ok";
            });
            guardarEstados();
            render();
            // el bloque siguiente queda arriba de todo, listo para seguir
            var y = bloque.getBoundingClientRect().bottom + window.scrollY;
            window.scrollTo({ top: y - 70, behavior: "smooth" });
            return;
        }

        var tarjeta = ev.target.closest(".tarjeta");
        if (!tarjeta) return;

        var id = tarjeta.dataset.id;
        var nuevo = CICLO[estados[id] || ""];
        if (nuevo) estados[id] = nuevo; else delete estados[id];
        guardarEstados();

        if (nuevo) tarjeta.dataset.estado = nuevo;
        else tarjeta.removeAttribute("data-estado");
        tarjeta.querySelector(".marca").textContent =
            { mal: "✕", duda: "?", ok: "✓" }[nuevo] || "";
        actualizarCuentas();
    });

    $filtro.addEventListener("change", function () {
        render();
        window.scrollTo({ top: 0 });
    });

    document.getElementById("btnCerrarAyuda").addEventListener("click", function () {
        document.getElementById("ayuda").classList.add("oculta");
    });

    document.getElementById("btnReset").addEventListener("click", function () {
        if (!confirm("Borra todas las marcas guardadas en este navegador. ¿Seguro?")) return;
        estados = {};
        guardarEstados();
        render();
    });

    document.getElementById("btnExportar").addEventListener("click", function () {
        var decisiones = {};
        datos.forEach(function (r) {
            if (estados[r.id]) decisiones[r.id] = estados[r.id];
        });
        var salida = {
            generado: new Date().toISOString(),
            total_auditadas: datos.length,
            decisiones: decisiones
        };
        var blob = new Blob([JSON.stringify(salida, null, 1)],
                            { type: "application/json" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "revision_fotos.json";
        a.click();
        URL.revokeObjectURL(a.href);
    });

    // ---------- arranque ----------

    fetch("data/fotos_auditoria.json")
        .then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
        })
        .then(function (j) {
            datos = j;
            cargarEstados();
            var sosp = datos.filter(function (r) { return r.sospecha > 0; }).length;
            $subtitulo.textContent =
                datos.length + " fotos sin verificar · " + sosp + " sospechosas";
            render();
        })
        .catch(function (e) {
            $contenido.innerHTML = '<p class="vacio">No se pudo leer ' +
                "<code>data/fotos_auditoria.json</code> (" + esc(e.message) + ").<br>" +
                "Corre <code>python auditar_fotos.py</code> y abri esta pagina " +
                "desde el servidor local, no como archivo suelto.</p>";
        });
})();
