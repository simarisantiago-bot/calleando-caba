"""
build_data.py — Pre-procesa calleando.xlsx y genera data/calles.json.

Lee las 27 hojas por letra (A-Z + N), unifica todas las filas,
normaliza los nombres del formato "APELLIDO, NOMBRE" a "Nombre Apellido"
para mejorar la tasa de exito del geocoding, y guarda un JSON
listo para consumir desde el navegador.

Uso:
    python build_data.py

Salida:
    data/calles.json   (~3141 entradas)
"""

import json
import re
import unicodedata
from pathlib import Path

import pandas as pd

EXCEL_PATH = Path(__file__).parent / "calleando.xlsx"
OUTPUT_DIR = Path(__file__).parent / "data"
OUTPUT_PATH = OUTPUT_DIR / "calles.json"

# Columnas reales del Excel (incluyen tildes)
COL_NOMBRE = "NOMBRE"
COL_CATEGORIA = "CATEGORÍA"
COL_TIPO = "TIPO DE ODÓNIMO"
COL_DESC = "DESCRIPCIÓN"


def normalizar_nombre_busqueda(nombre: str) -> str:
    """
    Convierte "ABDALA, GERMÁN" -> "Germán Abdala" para que Nominatim lo entienda.
    Si no hay coma, deja el texto en title case respetando preposiciones cortas.
    """
    if not isinstance(nombre, str):
        return ""
    s = nombre.strip()
    if not s:
        return ""

    # Caso "APELLIDO, NOMBRE" -> "Nombre Apellido"
    if "," in s:
        partes = [p.strip() for p in s.split(",", 1)]
        if len(partes) == 2 and partes[1]:
            s = f"{partes[1]} {partes[0]}"

    # Pasar a title case respetando minúsculas comunes
    palabras = s.split()
    minusculas = {"de", "del", "la", "las", "los", "y", "el", "en"}
    resultado = []
    for i, w in enumerate(palabras):
        wl = w.lower()
        if i > 0 and wl in minusculas:
            resultado.append(wl)
        else:
            resultado.append(wl.capitalize())
    return " ".join(resultado)


def clave_busqueda(texto: str) -> str:
    """
    Genera una clave normalizada para comparar busquedas:
    sin tildes, en minusculas, sin signos de puntuacion.
    """
    if not isinstance(texto, str):
        return ""
    s = unicodedata.normalize("NFKD", texto)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"[^\w\s]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def procesar():
    if not EXCEL_PATH.exists():
        raise SystemExit(f"No se encontró el archivo: {EXCEL_PATH}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    xl = pd.ExcelFile(EXCEL_PATH)
    hojas_calles = [s for s in xl.sheet_names if s.lower().startswith("letra")]
    print(f"Procesando {len(hojas_calles)} hojas...")

    registros = []
    nombres_vistos = set()

    for hoja in hojas_calles:
        df = pd.read_excel(EXCEL_PATH, sheet_name=hoja)

        # Verificar columnas (algunas hojas podrían tener variaciones)
        cols = {c.strip(): c for c in df.columns if isinstance(c, str)}
        if COL_NOMBRE not in cols:
            print(f"  AVISO: hoja '{hoja}' no tiene columna '{COL_NOMBRE}'. Salto.")
            continue

        for _, fila in df.iterrows():
            nombre_raw = fila.get(cols.get(COL_NOMBRE, COL_NOMBRE))
            if not isinstance(nombre_raw, str) or not nombre_raw.strip():
                continue

            nombre_raw = nombre_raw.strip()
            categoria = fila.get(cols.get(COL_CATEGORIA, COL_CATEGORIA), "")
            tipo = fila.get(cols.get(COL_TIPO, COL_TIPO), "")
            descripcion = fila.get(cols.get(COL_DESC, COL_DESC), "")

            categoria = str(categoria).strip() if pd.notna(categoria) else ""
            tipo = str(tipo).strip().lower() if pd.notna(tipo) else ""
            descripcion = str(descripcion).strip() if pd.notna(descripcion) else ""

            nombre_geocoding = normalizar_nombre_busqueda(nombre_raw)
            clave = clave_busqueda(nombre_geocoding)

            # Evitar duplicados exactos
            if clave in nombres_vistos:
                continue
            nombres_vistos.add(clave)

            registros.append({
                "nombre_original": nombre_raw,
                "nombre_busqueda": nombre_geocoding,
                "clave": clave,
                "categoria": categoria,
                "tipo": tipo,
                "descripcion": descripcion,
                "letra": hoja.replace("Letra ", "").strip(),
            })

        print(f"  {hoja}: {len(df)} filas -> {len(registros)} acumuladas")

    # Ordenar alfabéticamente por nombre normalizado (mejora el autocomplete)
    registros.sort(key=lambda r: r["clave"])

    with OUTPUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(registros, f, ensure_ascii=False, indent=2)

    print(f"\nGuardado: {OUTPUT_PATH}")
    print(f"Total entradas únicas: {len(registros)}")

    # Resumen por tipo
    tipos = {}
    for r in registros:
        tipos[r["tipo"]] = tipos.get(r["tipo"], 0) + 1
    print("\nDistribución por tipo:")
    for t, n in sorted(tipos.items(), key=lambda x: -x[1]):
        print(f"  {t or '(sin tipo)':20s} {n}")


if __name__ == "__main__":
    procesar()
