"""
auditar_fotos.py — Audita las fotos que la app resuelve por BÚSQUEDA EN VIVO,
es decir las entradas que no tienen clave en data/fotos.json.

Esas son las que nunca miró nadie: el mismo mecanismo produjo los 305 casos de
calles de personas ilustradas con batallas, provincias y embajadas que detectó
detectar_fotos_no_persona.py sobre el conjunto ya curado.

Hace dos chequeos sobre las entradas de categoría PERSONA, que son
complementarios (ninguno reemplaza al otro):

  1. NO ES PERSONA  — resuelve la entidad de Wikidata del artículo del que sale
     la foto y mira si es "ser humano" (P31 = Q5). Agarra la foto de una
     batalla, un río, una embajada.

  2. OTRA PERSONA   — compara el nombre esperado (el que la app extrae de la
     descripción, igual que nombreDesdeDescripcion en script.js) contra el
     título del artículo que matcheó. Agarra "Arcamendia -> Julio Troxler":
     Troxler es un humano, así que el chequeo 1 lo deja pasar tranquilo.

Sobre el resto de las categorías aplica un tercer chequeo, de coherencia entre
la categoría de la entrada y el tipo de cosa de la que habla el artículo:

  3. LUGAR         — una entrada de LUGAR ilustrada con un lugar está bien,
     aunque ese lugar quede en otro país: el odónimo homenajea justamente a
     ese lugar (la calle Albarracín con el pueblo de Albarracín, en Aragón).
     Al revés no: una entrada que no es de LUGAR ilustrada con un lugar está
     mal — la calle de un barco o de una fecha no va con la foto de un pueblo
     que comparte el nombre.

"Es un lugar" se decide por la presencia de coordenadas (P625) en Wikidata, no
por enumerar tipos de entidad: ciudad, pueblo, municipio, barrio, río, parque
y cerro son P31 distintos pero todos tienen coordenadas.

Lo que NO se chequea solo es el parecido entre el título y el odónimo fuera de
PERSONA, porque da muchos falsos positivos: Aguaí -> Pouteria salicifolia es
exactamente la especie correcta. Para esas se anota de qué tipo de cosa habla
el artículo, que es el dato que hace rápida la revisión a ojo.

Entrada:  data/calles.json, data/fotos.json, data/fotos_baseline.json
          (el baseline lo refresca medir_fotos.py; conviene correrlo antes)
Salida:   data/fotos_auditoria.json  — un registro por entrada, para la revisión
          data/fotos_auditoria.txt   — reporte legible, ordenado por sospecha

Uso:
    python medir_fotos.py        # refresca el baseline (opcional pero recomendado)
    python auditar_fotos.py
"""

import json
import re
import time
import unicodedata
from collections import Counter
from pathlib import Path

import requests

# La lista vive en medir_fotos.py, copiada 1:1 de BUSQUEDA_OVERRIDES en
# script.js. Se importa en vez de duplicarla para que no se desincronicen.
from medir_fotos import BUSQUEDA_OVERRIDES

BASE = Path(__file__).parent
DATA = BASE / "data"
CACHE = DATA / "_wikidata_cache.json"

WIKI_API = "https://es.wikipedia.org/w/api.php"
WD_API = "https://www.wikidata.org/w/api.php"
UA = "calleando-caba/1.0 (simarisantiago@gmail.com) auditoria-fotos"
LOTE = 25          # títulos/qids por request (la API admite 50; 25 deja margen)
Q_HUMANO = "Q5"

# Banderas que son evidencia de incoherencia entre la entrada y la foto, a
# diferencia de SIN_WIKIDATA, que sólo dice que no se pudo chequear.
BANDERAS_FUERTES = {
    "NO_ES_PERSONA", "OTRA_PERSONA", "LUGAR_SIN_LUGAR", "NO_DEBERIA_SER_LUGAR",
}

# Categorías cuyo sujeto ocurre o existe EN un lugar, así que tener
# coordenadas es lo esperable y no una señal de error.
CATEGORIAS_GEOGRAFICAS = {
    "LUGAR", "ACCIÓN MILITAR", "ACCION MILITAR", "RÍO", "RIO",
    "NATURALEZA", "PUEBLOS ORIGINARIOS",
}

S = requests.Session()
S.headers.update({"User-Agent": UA})


# --------------------------------------------------------------------------
# Normalización de nombres
# --------------------------------------------------------------------------

# Tratamientos y grados que aparecen en los odónimos pero no en el título del
# artículo ("Doctor Rodolfo Erausquin" -> el artículo es "Rodolfo Erausquin").
TRATAMIENTOS = {
    "doctor", "doctora", "general", "coronel", "teniente", "ingeniero",
    "profesor", "profesora", "almirante", "capitan", "sargento", "brigadier",
    "presidente", "intendente", "arquitecto", "maestro", "monsenor", "padre",
    "fray", "don", "dona", "santa", "santo", "san", "sor", "madre", "alferez",
    "comodoro", "mayor", "subteniente", "cabo", "soldado", "obispo",
}


def sin_acentos(s):
    s = unicodedata.normalize("NFD", (s or "").lower())
    return "".join(ch for ch in s if unicodedata.category(ch) != "Mn")


def palabras_nombre(s):
    """Palabras significativas de un nombre: 4+ letras, sin tratamientos."""
    return {w for w in re.findall(r"[a-z]{4,}", sin_acentos(s))} - TRATAMIENTOS


def nombre_desde_descripcion(desc):
    """Réplica de nombreDesdeDescripcion() en script.js."""
    if not desc:
        return ""
    n = desc.split("(")[0]
    if n == desc:
        n = re.split(r"[:;,]", desc)[0]
    return re.sub(r"\s+", " ", n).strip(" :;,")


# --------------------------------------------------------------------------
# Wikipedia / Wikidata en lotes
# --------------------------------------------------------------------------

class RateLimit(Exception):
    """Wikimedia cortó por cuota y no cedió tras todos los reintentos."""


def _get(url, params, intentos=6):
    """GET con backoff exponencial ante 429 / errores de red.

    Si se agotan los reintentos levanta RateLimit en vez de devolver None.
    Devolver None en silencio es justo cómo un chequeo anterior terminó
    informando 23 imágenes "rotas" que en realidad eran cuota agotada: un
    resultado vacío por rate limit es indistinguible de un resultado real
    salvo que se lo trate como error.
    """
    espera = 10
    ultimo = None
    for i in range(intentos):
        try:
            r = S.get(url, params=params, timeout=30)
            if r.status_code == 200:
                return r.json()
            ultimo = f"HTTP {r.status_code}"
            if r.status_code == 429:
                print(f"    [429] cuota agotada, esperando {espera}s "
                      f"(intento {i + 1}/{intentos})", flush=True)
                time.sleep(espera)
                espera = min(espera * 2, 120)
                continue
            time.sleep(2 + i)
        except Exception as e:
            ultimo = type(e).__name__
            time.sleep(2 + i)
    raise RateLimit(
        f"{url} no respondió tras {intentos} intentos (último: {ultimo}). "
        "Si medir_fotos.py está corriendo, esperá a que termine: la cuota de "
        "Wikimedia es por IP y la comparten es.wikipedia y Wikidata."
    )


def qids_de_titulos(titulos, cache=None):
    """{título de es.wiki -> qid}. En lotes, siguiendo redirecciones."""
    cache = cache if cache is not None else {}
    out = dict(cache)
    titulos = sorted({t for t in titulos if t and t not in cache})
    if not titulos:
        print("    qids: todo en cache")
        return out
    for i in range(0, len(titulos), LOTE):
        lote = titulos[i:i + LOTE]
        j = _get(WIKI_API, {
            "action": "query", "format": "json", "formatversion": "2",
            "titles": "|".join(lote), "prop": "pageprops",
            "ppprop": "wikibase_item", "redirects": "1",
        })
        q = j.get("query") or {}
        # normalized/redirects: mapear el título pedido al título final
        alias = {}
        for clave in ("normalized", "redirects"):
            for m in q.get(clave, []):
                alias[m["from"]] = m["to"]
        final = {}
        for p in q.get("pages", []):
            final[p.get("title")] = (p.get("pageprops") or {}).get("wikibase_item")
        for t in lote:
            destino = t
            for _ in range(3):                 # seguir cadenas de alias
                if destino in alias:
                    destino = alias[destino]
                else:
                    break
            out[t] = final.get(destino)
        print(f"    qids {min(i + LOTE, len(titulos))}/{len(titulos)}", flush=True)
        time.sleep(0.5)
    return out


def claims_de_qids(qids, cache=None):
    """{qid -> {"p31": [qids], "es_lugar": bool}}.

    "es_lugar" se decide por la presencia de P625 (coordenadas) en vez de
    enumerar tipos de entidad: ciudad, pueblo, municipio, barrio, río, parque
    y cerro son todos P31 distintos, pero todos tienen coordenadas y nadie que
    no sea un punto en el mapa las tiene. Viene en la misma respuesta que P31,
    así que no cuesta un request más.
    """
    cache = cache if cache is not None else {}
    out = dict(cache)
    qids = sorted({q for q in qids if q and q not in cache})
    if not qids:
        print("    claims: todo en cache")
        return out
    for i in range(0, len(qids), LOTE):
        lote = qids[i:i + LOTE]
        j = _get(WD_API, {
            "action": "wbgetentities", "format": "json",
            "ids": "|".join(lote), "props": "claims",
        })
        for qid, ent in (j.get("entities") or {}).items():
            claims = ent.get("claims") or {}
            vals = []
            for c in claims.get("P31", []):
                dv = ((c.get("mainsnak") or {}).get("datavalue") or {}).get("value") or {}
                if dv.get("id"):
                    vals.append(dv["id"])
            out[qid] = {"p31": vals, "es_lugar": bool(claims.get("P625"))}
        print(f"    claims {min(i + LOTE, len(qids))}/{len(qids)}", flush=True)
        time.sleep(0.5)
    return out


def etiquetas(qids):
    """{qid -> etiqueta en español (o inglés)}."""
    out = {}
    qids = sorted({q for q in qids if q})
    for i in range(0, len(qids), LOTE):
        lote = qids[i:i + LOTE]
        j = _get(WD_API, {
            "action": "wbgetentities", "format": "json",
            "ids": "|".join(lote), "props": "labels", "languages": "es|en",
        })
        for qid, ent in (j.get("entities") or {}).items():
            lab = (ent.get("labels") or {})
            out[qid] = ((lab.get("es") or lab.get("en") or {}).get("value")) or qid
        time.sleep(0.5)
    return out


# --------------------------------------------------------------------------

def main():
    calles = json.load(open(DATA / "calles.json", encoding="utf-8"))
    fotos = json.load(open(DATA / "fotos.json", encoding="utf-8"))
    baseline = json.load(open(DATA / "fotos_baseline.json", encoding="utf-8"))

    def base_de(c):
        return baseline.get(c.get("id")) or baseline.get(c.get("clave")) or {}

    def curada(c):
        return fotos.get(c.get("id")) or fotos.get(c.get("clave"))

    # Entradas que hoy dependen de la búsqueda en vivo Y consiguen imagen.
    revisar = [c for c in calles if not curada(c) and base_de(c).get("thumb")]
    print(f"A auditar: {len(revisar)} entradas con foto de búsqueda en vivo")

    personas = [c for c in revisar
                if (c.get("categoria") or "").strip().upper() == "PERSONA"]
    print(f"  de las cuales PERSONA: {len(personas)}")

    # --- Wikidata, en lotes, para TODAS (el tipo de entidad también sirve
    #     como contexto en la revisión a ojo de las que no son PERSONA) ---
    print("\nResolviendo entidades de Wikidata...")
    # Cache en disco de lo consultado a Wikidata. Afinar las reglas de abajo
    # es iterativo, y sin esto cada vuelta cuesta otra pasada entera de API
    # (y otro riesgo de que la cuota corte a mitad de camino). Es regenerable:
    # borrar el archivo fuerza la consulta de nuevo.
    cache = {"titulos": {}, "claims": {}, "labels": {}}
    if CACHE.exists():
        try:
            cache.update(json.load(open(CACHE, encoding="utf-8")))
            print(f"  cache: {len(cache['titulos'])} títulos, "
                  f"{len(cache['claims'])} entidades")
        except Exception:
            print("  cache ilegible, se reconstruye")

    titulos = {base_de(c).get("titulo") for c in revisar}
    t2q = qids_de_titulos(titulos, cache["titulos"])
    q2cl = claims_de_qids(t2q.values(), cache["claims"])
    todas_p31 = {q for v in q2cl.values() for q in v["p31"]}
    faltan = todas_p31 - set(cache["labels"])
    q2lab = dict(cache["labels"])
    if faltan:
        q2lab.update(etiquetas(faltan))

    cache.update({"titulos": t2q, "claims": q2cl, "labels": q2lab})
    json.dump(cache, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False)

    # --- Armar los registros ---
    registros = []
    for c in revisar:
        b = base_de(c)
        cat = (c.get("categoria") or "").strip().upper()
        titulo = b.get("titulo")
        qid = t2q.get(titulo)
        cl = q2cl.get(qid) or {"p31": [], "es_lugar": False}
        p31, es_lugar = cl["p31"], cl["es_lugar"]
        tipos = [q2lab.get(q, q) for q in p31]

        esperado = nombre_desde_descripcion(c.get("descripcion")) or c.get("nombre_busqueda")

        banderas = []
        if c.get("id") in BUSQUEDA_OVERRIDES:
            # La entrada tiene un término de búsqueda elegido a mano en
            # script.js: el artículo al que llega es el que alguien decidió
            # que llegara. No hay nada que auditar — "Independencia" apunta
            # al Congreso de Tucumán justamente porque sin el override traía
            # la Declaración de Independencia de EE.UU.
            banderas.append("OVERRIDE_MANUAL")
        elif cat == "PERSONA":
            if qid and p31 and Q_HUMANO not in p31:
                banderas.append("NO_ES_PERSONA")
            # El título se compara contra el nombre esperado Y contra el
            # odónimo. Muchas entradas describen a la persona por su nombre
            # real mientras la calle usa el seudónimo con el que se la conoce
            # (Atahualpa Yupanqui es Héctor Chavero; Voltaire es François
            # Arouet). Alcanza con que coincida cualquiera de los dos.
            pal_tit = palabras_nombre(titulo)
            pal_ref = (palabras_nombre(esperado)
                       | palabras_nombre(c.get("nombre_busqueda")))
            if pal_ref and pal_tit and not (pal_ref & pal_tit):
                banderas.append("OTRA_PERSONA")
        elif cat == "LUGAR":
            # Criterio editorial: una entrada de LUGAR ilustrada con un lugar
            # está bien, aunque ese lugar quede en otro país — el odónimo
            # homenajea justamente a ese lugar.
            if qid and not es_lugar:
                banderas.append("LUGAR_SIN_LUGAR")
        elif cat not in CATEGORIAS_GEOGRAFICAS:
            # Y al revés: una categoría que NO es geográfica tampoco se ilustra
            # con un lugar. Una calle que recuerda un barco o una fecha no va
            # con la foto de un pueblo que comparte el nombre.
            #
            # El chequeo se saltea en las categorías de CATEGORIAS_GEOGRAFICAS
            # porque ahí tener coordenadas es lo correcto, no el error: una
            # batalla ocurrió en un lugar, un río corre por uno y un parque
            # nacional es uno. Aplicarlo a todas daba 8 falsos positivos sobre
            # 10 — Tuyutí, Talampaya o el Congreso de Tucumán marcados por
            # estar, razonablemente, en el mapa.
            if qid and es_lugar:
                banderas.append("NO_DEBERIA_SER_LUGAR")

        if qid is None:
            banderas.append("SIN_WIKIDATA")

        registros.append({
            "id": c.get("id"),
            "clave": c.get("clave"),
            "nombre": c.get("nombre_busqueda"),
            "categoria": c.get("categoria"),
            "descripcion": c.get("descripcion"),
            "thumb": b.get("thumb"),
            "titulo": titulo,
            "termino_ok": b.get("termino_ok"),
            "nombre_esperado": esperado,
            "qid": qid,
            "tipos": tipos,
            "es_lugar": es_lugar,
            "banderas": banderas,
            # las banderas de incoherencia pesan más que "sin wikidata", que
            # es sólo falta de datos y no evidencia de que la foto esté mal
            "sospecha": sum(3 if f in BANDERAS_FUERTES
                            else 0 if f == "OVERRIDE_MANUAL" else 1
                            for f in banderas),
        })

    registros.sort(key=lambda r: (-r["sospecha"], r["categoria"] or "", r["nombre"] or ""))
    json.dump(registros, open(DATA / "fotos_auditoria.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    # --- Reporte legible ---
    sospechosas = [r for r in registros if r["sospecha"] > 0]
    # Sólo las banderas de las sospechosas: OVERRIDE_MANUAL no es un hallazgo
    # sino lo contrario (una entrada que se decidió no auditar), y mezclarlo
    # acá lo hacía parecer un problema más.
    cuenta = Counter(f for r in sospechosas for f in r["banderas"])
    con_override = sum(1 for r in registros if "OVERRIDE_MANUAL" in r["banderas"])

    L = []
    L.append("AUDITORÍA DE FOTOS — entradas que la app resuelve por búsqueda en vivo")
    L.append("")
    L.append(f"Auditadas            : {len(registros)}")
    L.append(f"  de categoría PERSONA: {len(personas)}")
    L.append(f"Marcadas sospechosas : {len(sospechosas)}")
    L.append(f"No auditadas (término elegido a mano en script.js): {con_override}")
    L.append("")
    L.append("Por bandera (sólo las sospechosas):")
    for f, n in cuenta.most_common():
        L.append(f"  {f:16s} {n:4d}")
    L.append("")
    L.append("=" * 72)
    L.append("SOSPECHOSAS (revisar primero)")
    L.append("=" * 72)
    for r in sospechosas:
        L.append(f"  {r['nombre']}  [{r['categoria']}]")
        L.append(f"       esperaba : {r['nombre_esperado']}")
        L.append(f"       la foto sale de: {r['titulo']}"
                 + (f"  ({', '.join(r['tipos'][:3])})" if r["tipos"] else ""))
        L.append(f"       banderas : {', '.join(r['banderas'])}")
    L.append("")
    L.append("=" * 72)
    L.append("EL RESTO, POR CATEGORÍA (sin chequeo automático confiable)")
    L.append("=" * 72)
    resto = Counter(r["categoria"] for r in registros if r["sospecha"] == 0)
    for cat, n in resto.most_common():
        L.append(f"  {cat:22s} {n:5d}")

    txt = "\n".join(L)
    (DATA / "fotos_auditoria.txt").write_text(txt + "\n", encoding="utf-8")
    print("\n" + txt[:2000])
    print(f"\nJSON: {DATA / 'fotos_auditoria.json'}")
    print(f"TXT : {DATA / 'fotos_auditoria.txt'}")


if __name__ == "__main__":
    try:
        main()
    except RateLimit as e:
        raise SystemExit(f"[ABORTADO] {e} "
                         "No se escribió ninguna salida: una auditoría a "
                         "medias es peor que ninguna.")
