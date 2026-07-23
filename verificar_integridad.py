"""
verificar_integridad.py — Chequeos rápidos de consistencia entre
data/calles.json, data/geo_cache.json y data/fotos.json.

Detecta:
    - ids duplicados en calles.json (dos entradas con el mismo id
      "clave|tipo" — script.js/geo_cache solo puede representar una).
    - Entradas de geo_cache.json cuyo id ya no existe en calles.json
      (huérfanas, típicamente restos de renombres o eliminaciones).
    - Entradas de fotos.json cuya clave (o id, para overrides puntuales
      tipo "clave|tipo") ya no existe en calles.json.
    - Entradas de calles.json sin campos obligatorios.

No modifica nada — solo informa. Pensado para correrse a mano después
de una tanda grande de ediciones, o antes de un "commitea y pushea".

Uso:
    python verificar_integridad.py

Salida: reporte por consola. Código de salida 0 si no encontró
problemas, 1 si encontró alguno (útil para un hook o CI).
"""

import json
import sys
from collections import Counter
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
CAMPOS_OBLIGATORIOS = ("nombre_original", "nombre_busqueda", "clave", "id", "categoria", "tipo", "descripcion")


def cargar(nombre):
    with open(DATA_DIR / nombre, encoding="utf-8") as f:
        return json.load(f)


def main():
    calles = cargar("calles.json")
    cache = cargar("geo_cache.json")
    fotos = cargar("fotos.json")

    problemas = 0

    # ---- 1. ids duplicados en calles.json ----
    conteo_ids = Counter(c["id"] for c in calles)
    duplicados = [id_ for id_, n in conteo_ids.items() if n > 1]
    if duplicados:
        problemas += len(duplicados)
        print(f"[FALLA] {len(duplicados)} id(s) duplicados en calles.json:")
        for id_ in duplicados:
            print(f"    - {id_}  (x{conteo_ids[id_]})")
    else:
        print("[OK] Sin ids duplicados en calles.json.")

    # ---- 2. campos obligatorios faltantes ----
    incompletas = []
    for c in calles:
        faltantes = [campo for campo in CAMPOS_OBLIGATORIOS if not c.get(campo)]
        if faltantes:
            incompletas.append((c.get("id", "<sin id>"), faltantes))
    if incompletas:
        problemas += len(incompletas)
        print(f"[FALLA] {len(incompletas)} entrada(s) con campos vacíos/faltantes:")
        for id_, faltantes in incompletas:
            print(f"    - {id_}: falta {', '.join(faltantes)}")
    else:
        print("[OK] Todas las entradas tienen los campos obligatorios.")

    # ---- 3. huérfanos en geo_cache.json ----
    ids_calles = {c["id"] for c in calles}
    huerfanos_cache = sorted(k for k in cache if k not in ids_calles)
    if huerfanos_cache:
        problemas += len(huerfanos_cache)
        print(f"[FALLA] {len(huerfanos_cache)} entrada(s) huérfanas en geo_cache.json:")
        for k in huerfanos_cache:
            print(f"    - {k}")
    else:
        print("[OK] Sin huérfanos en geo_cache.json.")

    # ---- 4. huérfanos en fotos.json ----
    claves_calles = {c["clave"] for c in calles}
    huerfanos_fotos = []
    for k in fotos:
        if "|" in k:
            # override puntual por id ("clave|tipo")
            if k not in ids_calles:
                huerfanos_fotos.append(k)
        elif k not in claves_calles:
            huerfanos_fotos.append(k)
    huerfanos_fotos.sort()
    if huerfanos_fotos:
        problemas += len(huerfanos_fotos)
        print(f"[FALLA] {len(huerfanos_fotos)} entrada(s) huérfanas en fotos.json:")
        for k in huerfanos_fotos:
            print(f"    - {k}")
    else:
        print("[OK] Sin huérfanos en fotos.json.")

    print()
    print(f"Total: {len(calles)} calles, {len(cache)} geometrías, {len(fotos)} fotos.")
    if problemas:
        print(f"\n{problemas} problema(s) encontrados.")
        return 1
    print("\nTodo consistente.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
