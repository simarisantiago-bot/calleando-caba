"""
aplicar_revision.py — Aplica a data/fotos.json las decisiones tomadas en la
hoja de contactos (revisar_fotos.html).

Flujo completo:
    python medir_fotos.py       # que foto resuelve hoy cada odonimo
    python auditar_fotos.py     # marca las sospechosas
    # abrir http://localhost:8080/revisar_fotos.html y revisar
    python aplicar_revision.py revision_fotos.json            # informe
    python aplicar_revision.py revision_fotos.json --aplicar  # escribe

Que hace con cada decision:
    mal   -> {"sinFoto": true}: la entrada pasa a mostrar el isotipo de marca
             en vez de la foto equivocada.
    ok    -> congela la foto en data/fotos.json con su atribucion de Commons,
             asi deja de depender de la busqueda en vivo (que no es
             determinista: dos corridas del mismo dia dan resultados
             distintos para un puñado de entradas).
    duda  -> no toca nada; la entrada sigue resolviendose en vivo.

Por defecto NO escribe: imprime el informe de lo que haria. Hace falta
--aplicar para tocar data/fotos.json.

Sobre como escribe: carga el data/fotos.json existente, modifica las claves
que corresponden y lo reescribe entero pretty-printed. Nunca arma un
diccionario nuevo desde cero — asi fue como en septiembre de 2026 se
perdieron 1399 entradas de un archivo curado a mano (ver CLAUDE.md).
"""

import argparse
import json
import re
import time
import urllib.parse
from collections import defaultdict
from pathlib import Path

import requests

BASE = Path(__file__).parent
DATA = BASE / "data"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
UA = "calleando-caba/1.0 (simarisantiago@gmail.com) aplicar-revision"
LOTE = 50

S = requests.Session()
S.headers.update({"User-Agent": UA})


def filename_desde_thumb(url):
    """Nombre del archivo en Commons a partir de la URL de la miniatura.

    Las miniaturas vienen como
        .../commons/thumb/7/71/Nombre_Del_Archivo.jpg/500px-Nombre...jpg
    y las imagenes directas como
        .../commons/7/71/Nombre_Del_Archivo.jpg
    En el primer caso el nombre real es el segmento ANTERIOR al 500px-...,
    no el ultimo: quedarse con el ultimo da un archivo que no existe.
    """
    if not url:
        return None
    ruta = urllib.parse.urlparse(url).path
    m = re.search(r"/commons/thumb/[0-9a-f]/[0-9a-f]{2}/([^/]+)/", ruta)
    if not m:
        m = re.search(r"/commons/[0-9a-f]/[0-9a-f]{2}/([^/]+)$", ruta)
    if not m:
        return None
    return urllib.parse.unquote(m.group(1)).replace("_", " ")


def sin_html(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s or "")).strip()


def atribucion(filenames):
    """{filename -> {autor, licencia}}, en lotes de 50."""
    out = {}
    filenames = sorted({f for f in filenames if f})
    for i in range(0, len(filenames), LOTE):
        lote = filenames[i:i + LOTE]
        params = {
            "action": "query", "format": "json",
            "titles": "|".join("File:" + f for f in lote),
            "prop": "imageinfo", "iiprop": "extmetadata",
            "iiextmetadatafilter": "Artist|LicenseShortName",
        }
        j = None
        espera = 5
        for intento in range(5):
            try:
                r = S.get(COMMONS_API, params=params, timeout=40)
                if r.status_code == 200:
                    j = r.json()
                    break
                if r.status_code == 429:
                    time.sleep(espera)
                    espera = min(espera * 2, 120)
                    continue
                time.sleep(2 + intento)
            except Exception:
                time.sleep(2 + intento)
        if j is None:
            raise SystemExit(
                "[ABORTADO] Commons no respondio para un lote de atribuciones. "
                "No se escribio nada: sin atribucion las fotos no se pueden "
                "publicar. Reintenta en unos minutos."
            )
        for p in ((j.get("query") or {}).get("pages") or {}).values():
            titulo = (p.get("title") or "").replace("File:", "")
            ii = (p.get("imageinfo") or [{}])[0].get("extmetadata") or {}
            out[titulo] = {
                "autor": sin_html((ii.get("Artist") or {}).get("value", ""))
                         or "Wikimedia Commons",
                "licencia": sin_html((ii.get("LicenseShortName") or {}).get("value", ""))
                            or "ver en Commons",
            }
        print(f"  atribucion {min(i + LOTE, len(filenames))}/{len(filenames)}", flush=True)
        time.sleep(0.5)
    return out


def claves_a_escribir(decisiones, calles):
    """Decide si cada decision se guarda por `id` o por `clave`.

    data/fotos.json acepta las dos formas (script.js busca primero por id
    completo y despues por clave). Cuando TODAS las entradas que comparten
    una clave recibieron el mismo veredicto, alcanza una sola entrada por
    clave; si difieren, va una por id. Es cosmetico, pero mantiene el archivo
    parecido a como esta hoy en vez de duplicar entradas.
    """
    por_clave = defaultdict(list)
    for c in calles:
        por_clave[c["clave"]].append(c["id"])

    salida = {}
    for clave, ids in por_clave.items():
        verdicts = {i: decisiones.get(i) for i in ids}
        presentes = [v for v in verdicts.values() if v]
        if not presentes:
            continue
        if len(presentes) == len(ids) and len(set(presentes)) == 1:
            salida[clave] = presentes[0]
        else:
            for i, v in verdicts.items():
                if v:
                    salida[i] = v
    return salida


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("revision", nargs="?", default="revision_fotos.json",
                    help="JSON exportado por revisar_fotos.html")
    ap.add_argument("--aplicar", action="store_true",
                    help="escribe data/fotos.json (si no, solo informa)")
    args = ap.parse_args()

    ruta = Path(args.revision)
    if not ruta.exists():
        raise SystemExit(f"No existe {ruta}. Exportalo desde revisar_fotos.html.")

    revision = json.load(open(ruta, encoding="utf-8"))
    decisiones = revision.get("decisiones") or {}
    auditoria = {r["id"]: r for r in
                 json.load(open(DATA / "fotos_auditoria.json", encoding="utf-8"))}
    calles = json.load(open(DATA / "calles.json", encoding="utf-8"))
    fotos = json.load(open(DATA / "fotos.json", encoding="utf-8"))

    cuenta = defaultdict(int)
    for v in decisiones.values():
        cuenta[v] += 1
    print(f"Revision de {revision.get('generado', '?')}")
    print(f"  marcadas mal  : {cuenta['mal']}")
    print(f"  confirmadas ok: {cuenta['ok']}")
    print(f"  dudosas       : {cuenta['duda']}  (no se tocan)")

    efectivas = {k: v for k, v in decisiones.items() if v in ("mal", "ok")}
    if not efectivas:
        raise SystemExit("\nNo hay decisiones que aplicar.")

    destino = claves_a_escribir(efectivas, calles)
    por_id = sum(1 for k in destino if "|" in k)
    print(f"\n{len(destino)} claves a escribir "
          f"({len(destino) - por_id} por clave, {por_id} por id)")

    # Atribucion solo para las que se confirman OK.
    oks = {k: v for k, v in destino.items() if v == "ok"}
    attr, fn_de = {}, {}
    if oks:
        for k in oks:
            # la clave puede ser id o clave; el registro de auditoria es por id
            reg = auditoria.get(k) or next(
                (r for r in auditoria.values() if r["clave"] == k), None)
            if reg:
                fn_de[k] = filename_desde_thumb(reg.get("thumb"))
        sin_fn = [k for k, f in fn_de.items() if not f]
        if sin_fn:
            print(f"  [aviso] {len(sin_fn)} sin nombre de archivo reconocible; "
                  f"se omiten: {sin_fn[:3]}")
        print(f"\nPidiendo atribucion de {len(set(filter(None, fn_de.values())))} "
              f"archivos a Commons...")
        attr = atribucion(fn_de.values())

    nuevas, pisadas = 0, []
    for k, v in destino.items():
        if k in fotos:
            pisadas.append(k)
        if v == "mal":
            fotos[k] = {"sinFoto": True}
            nuevas += 1
            continue
        fn = fn_de.get(k)
        if not fn:
            continue
        reg = auditoria.get(k) or next(
            (r for r in auditoria.values() if r["clave"] == k), None)
        a = attr.get(fn, {})
        fotos[k] = {
            "thumbUrl": reg.get("thumb"),
            "pageUrl": "https://commons.wikimedia.org/wiki/File:"
                       + urllib.parse.quote(fn.replace(" ", "_")),
            "titulo": reg.get("titulo") or reg.get("nombre"),
            "autor": a.get("autor", "Wikimedia Commons"),
            "licencia": a.get("licencia", "ver en Commons"),
        }
        nuevas += 1

    if pisadas:
        print(f"  [aviso] {len(pisadas)} claves ya existian en fotos.json "
              f"y se pisan: {pisadas[:3]}")

    print(f"\nResultado: {len(fotos)} entradas en fotos.json "
          f"({nuevas} agregadas o modificadas)")

    if not args.aplicar:
        print("\n(informe solamente — volve a correrlo con --aplicar para escribir)")
        return

    fotos = dict(sorted(fotos.items()))
    with open(DATA / "fotos.json", "w", encoding="utf-8", newline="\n") as f:
        json.dump(fotos, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")
    print("\ndata/fotos.json escrito. Corre verificar_integridad.py y mira el mapa.")


if __name__ == "__main__":
    main()
