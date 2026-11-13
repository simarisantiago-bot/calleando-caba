"""
aplicar_planilla.py — Aplica a data/fotos.json las planillas de comuna
completadas (las que arma generar_planillas.py).

Lee la columna VEREDICTO de cada fila:

    ok                      congela la foto que la entrada ya muestra, con su
                            atribucion de Commons
    sin foto                {"sinFoto": true}: isotipo de marca
    link a Commons          commons.wikimedia.org/wiki/File:...
    link a Wikipedia        es.wikipedia.org/wiki/...  -> se usa la imagen
                            principal del articulo
    vacio                   sin decidir: no se toca la entrada

Por defecto NO escribe: imprime el informe de lo que haria. Hace falta
--aplicar para tocar data/fotos.json.

Como escribe: carga el data/fotos.json existente, modifica las claves que
corresponden y lo reescribe entero pretty-printed. Nunca arma un diccionario
nuevo desde cero (ver CLAUDE.md: asi se perdieron 1399 entradas en septiembre
de 2026).

Uso:
    python aplicar_planilla.py planillas/comuna_01.xlsx
    python aplicar_planilla.py planillas/*.xlsx --aplicar
"""

import argparse
import json
import re
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

import openpyxl
import requests

BASE = Path(__file__).parent
DATA = BASE / "data"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
WIKI_API = "https://es.wikipedia.org/w/api.php"
UA = "calleando-caba/1.0 (simarisantiago@gmail.com) aplicar-planilla"
LOTE = 50
COL_ID, COL_VEREDICTO = 1, 8
PRIMERA_FILA = 3          # 1 es cabecera, 2 son las notas

S = requests.Session()
S.headers.update({"User-Agent": UA})


# --------------------------------------------------------------------------
# Resolucion de links
# --------------------------------------------------------------------------

def archivo_de_commons(url):
    """Nombre del archivo a partir de una URL de pagina de Commons."""
    m = re.search(r"/wiki/(?:File|Archivo):(.+)$", url)
    if not m:
        return None
    return urllib.parse.unquote(m.group(1).split("#")[0]).replace("_", " ")


def archivo_de_url_imagen(url):
    """Nombre del archivo a partir de una URL de imagen (thumb o directa).

    En las miniaturas el nombre real es el segmento ANTERIOR al 500px-...,
    no el ultimo: quedarse con el ultimo da un archivo que no existe.
    """
    ruta = urllib.parse.urlparse(url).path
    m = (re.search(r"/commons/thumb/[0-9a-f]/[0-9a-f]{2}/([^/]+)/", ruta)
         or re.search(r"/commons/[0-9a-f]/[0-9a-f]{2}/([^/]+)$", ruta)
         or re.search(r"Special:FilePath/([^?]+)", url))
    return urllib.parse.unquote(m.group(1)).replace("_", " ") if m else None


def imagen_de_articulo(url):
    """Imagen principal de un articulo de Wikipedia -> nombre de archivo."""
    m = re.search(r"/wiki/(.+)$", url)
    if not m:
        return None
    titulo = urllib.parse.unquote(m.group(1).split("#")[0]).replace("_", " ")
    try:
        r = S.get(WIKI_API, params={
            "action": "query", "format": "json", "formatversion": "2",
            "titles": titulo, "prop": "pageimages", "piprop": "original",
            "redirects": "1",
        }, timeout=30)
        pages = (r.json().get("query") or {}).get("pages") or []
        src = (pages[0].get("original") or {}).get("source") if pages else None
        return archivo_de_url_imagen(src) if src else None
    except Exception:
        return None


def resolver(veredicto):
    """(accion, filename|None, nota). accion: ok | sinfoto | archivo | error."""
    v = (veredicto or "").strip()
    if not v:
        return ("vacio", None, "")
    bajo = v.lower()
    if bajo in ("ok", "si", "sí", "correcta", "correcto"):
        return ("ok", None, "")
    if bajo in ("sin foto", "sinfoto", "no", "ninguna"):
        return ("sinfoto", None, "")
    if not bajo.startswith("http"):
        return ("error", None, f"no entiendo {v!r}")

    host = urllib.parse.urlparse(v).netloc
    if "commons.wikimedia.org" in host:
        fn = archivo_de_commons(v) or archivo_de_url_imagen(v)
        return ("archivo", fn, "") if fn else ("error", None, "link de Commons sin archivo")
    if "wikipedia.org" in host:
        fn = imagen_de_articulo(v)
        return ("archivo", fn, "") if fn else ("error", None, "el articulo no tiene imagen")
    if "upload.wikimedia.org" in host or "thumb.wikimedia.org" in host:
        fn = archivo_de_url_imagen(v)
        return ("archivo", fn, "") if fn else ("error", None, "no pude sacar el archivo")
    return ("error", None, "solo sirven links de Wikimedia (ver licencia)")


# --------------------------------------------------------------------------

def sin_html(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s or "")).strip()


def atribucion(filenames):
    """{filename -> {autor, licencia}}, en lotes de 50."""
    out = {}
    filenames = sorted({f for f in filenames if f})
    for i in range(0, len(filenames), LOTE):
        lote = filenames[i:i + LOTE]
        j, espera = None, 5
        for intento in range(5):
            try:
                r = S.get(COMMONS_API, params={
                    "action": "query", "format": "json",
                    "titles": "|".join("File:" + f for f in lote),
                    "prop": "imageinfo", "iiprop": "extmetadata",
                    "iiextmetadatafilter": "Artist|LicenseShortName",
                }, timeout=40)
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
                "No se escribio nada: sin atribucion las fotos no se publican."
            )
        for p in ((j.get("query") or {}).get("pages") or {}).values():
            if "missing" in p:
                continue
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
    """Guarda por `clave` cuando todas las entradas que la comparten reciben
    el mismo veredicto; si difieren, por `id`. Mantiene fotos.json parecido a
    como esta hoy en vez de duplicar entradas."""
    por_clave = defaultdict(list)
    for c in calles:
        por_clave[c["clave"]].append(c["id"])
    salida = {}
    for clave, ids in por_clave.items():
        v = {i: decisiones.get(i) for i in ids}
        presentes = [x for x in v.values() if x]
        if not presentes:
            continue
        if len(presentes) == len(ids) and len({json.dumps(x, sort_keys=True)
                                               for x in presentes}) == 1:
            salida[clave] = presentes[0]
        else:
            for i, x in v.items():
                if x:
                    salida[i] = x
    return salida


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("planillas", nargs="+", help="xlsx completados")
    ap.add_argument("--aplicar", action="store_true",
                    help="escribe data/fotos.json (si no, solo informa)")
    args = ap.parse_args()

    auditoria = {r["id"]: r for r in
                 json.load(open(DATA / "fotos_auditoria.json", encoding="utf-8"))}
    calles = json.load(open(DATA / "calles.json", encoding="utf-8"))
    fotos = json.load(open(DATA / "fotos.json", encoding="utf-8"))
    ids_validos = {c["id"] for c in calles}

    # id -> ("ok"|"sinfoto"|"archivo", filename)
    crudas, errores, cuenta = {}, [], defaultdict(int)
    for ruta in args.planillas:
        wb = openpyxl.load_workbook(ruta, read_only=True)
        ws = wb.active
        n = 0
        for fila in ws.iter_rows(min_row=PRIMERA_FILA, values_only=True):
            ident = fila[COL_ID - 1]
            if not ident:
                continue
            accion, fn, nota = resolver(fila[COL_VEREDICTO - 1])
            if accion == "vacio":
                continue
            if ident not in ids_validos:
                errores.append(f"{Path(ruta).name}: id desconocido {ident!r}")
                continue
            if accion == "error":
                errores.append(f"{Path(ruta).name}: {ident} -> {nota}")
                continue
            crudas[ident] = (accion, fn)
            cuenta[accion] += 1
            n += 1
        wb.close()
        print(f"{Path(ruta).name}: {n} filas con veredicto")

    print(f"\n  ok        {cuenta['ok']}")
    print(f"  sin foto  {cuenta['sinfoto']}")
    print(f"  con link  {cuenta['archivo']}")
    if errores:
        print(f"\n  {len(errores)} filas con problema:")
        for e in errores[:12]:
            print(f"    {e}")
        if len(errores) > 12:
            print(f"    ... y {len(errores) - 12} mas")
    if not crudas:
        raise SystemExit("\nNo hay decisiones que aplicar.")

    # Archivos cuya atribucion hay que pedir: los de link, mas los "ok" (que
    # se congelan con la foto que ya muestran).
    necesita_fn = {}
    for ident, (accion, fn) in crudas.items():
        if accion == "archivo":
            necesita_fn[ident] = fn
        elif accion == "ok":
            reg = auditoria.get(ident)
            necesita_fn[ident] = archivo_de_url_imagen(reg.get("thumb")) if reg else None

    faltantes = [i for i, f in necesita_fn.items() if not f]
    if faltantes:
        print(f"\n  [aviso] {len(faltantes)} sin archivo reconocible, se omiten: "
              f"{faltantes[:3]}")

    print(f"\nPidiendo atribucion de {len(set(filter(None, necesita_fn.values())))} "
          f"archivos a Commons...")
    attr = atribucion(necesita_fn.values())

    # Armar la entrada final de cada id
    decisiones = {}
    for ident, (accion, _) in crudas.items():
        if accion == "sinfoto":
            decisiones[ident] = {"sinFoto": True}
            continue
        fn = necesita_fn.get(ident)
        if not fn:
            continue
        a = attr.get(fn)
        if a is None:
            errores.append(f"{ident}: Commons no conoce File:{fn}")
            continue
        reg = auditoria.get(ident) or {}
        decisiones[ident] = {
            "thumbUrl": "https://commons.wikimedia.org/wiki/Special:FilePath/"
                        + urllib.parse.quote(fn.replace(" ", "_")) + "?width=480",
            "pageUrl": "https://commons.wikimedia.org/wiki/File:"
                       + urllib.parse.quote(fn.replace(" ", "_")),
            "titulo": reg.get("titulo") or reg.get("nombre") or fn,
            "autor": a["autor"],
            "licencia": a["licencia"],
        }

    destino = claves_a_escribir(decisiones, calles)
    por_id = sum(1 for k in destino if "|" in k)
    pisadas = [k for k in destino if k in fotos]
    print(f"\n{len(destino)} claves a escribir "
          f"({len(destino) - por_id} por clave, {por_id} por id)")
    if pisadas:
        print(f"  [aviso] {len(pisadas)} ya existian y se pisan: {pisadas[:3]}")

    for k, v in destino.items():
        fotos[k] = v
    print(f"Resultado: {len(fotos)} entradas en fotos.json")

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
