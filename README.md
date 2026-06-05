# Calleando CABA

Mapa interactivo de las calles, plazas y avenidas de la Ciudad de Buenos Aires,
con su historia y descripción de a quién o qué hace referencia.

## Empezar en 3 pasos

### 1. Generar los datos
```powershell
python build_data.py
```
Esto lee `calleando.xlsx` y crea `data/calles.json` con ~2.964 entradas.

### 2. Probar localmente
```powershell
python -m http.server 8080
```
Abrir http://localhost:8080 en el navegador.

### 3. Publicar en Vercel
```powershell
git init
git add .
git commit -m "primer commit"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/calleando-caba.git
git push -u origin main
```
Después, conectar el repo en https://vercel.com/new y listo. Cada push a `main`
redeploya automáticamente.

## Cómo funciona

1. Al abrir la web, JS carga `data/calles.json` en memoria.
2. Cuando escribís en la búsqueda, te aparecen sugerencias filtradas de ese JSON.
3. Cuando elegís una, el navegador consulta **Nominatim** (OpenStreetMap)
   para obtener las coordenadas reales de la calle/plaza.
4. Se dibuja una línea azul (si es calle) o un marcador (si es plaza/parque),
   con un popup que muestra el nombre y la descripción del Excel.
5. La respuesta de Nominatim se guarda en `localStorage` del navegador, así que
   las búsquedas repetidas son instantáneas.

## Cuando edites el Excel

```powershell
python build_data.py
git add data/calles.json calleando.xlsx
git commit -m "actualizar calles"
git push
```

## Fase 2 (futuro): pre-geocodificar todo

La búsqueda en vivo funciona pero depende de la API de OpenStreetMap. Para que
todo sea instantáneo y no falle nunca, hay que correr un script que pregunte
a Nominatim por cada una de las 2.964 entradas y guarde las coordenadas
directamente en `calles.json`. Ese script todavía no está hecho — avisame
cuando lo quieras y lo armamos.

## Tecnologías

- [Leaflet](https://leafletjs.com/) — mapa interactivo
- [CartoDB Positron](https://github.com/CartoDB/basemap-styles) — estilo de mapa claro
- [Nominatim](https://nominatim.org/) — geocodificación gratuita de OpenStreetMap
- [pandas](https://pandas.pydata.org/) + [openpyxl](https://openpyxl.readthedocs.io/) — lectura del Excel
