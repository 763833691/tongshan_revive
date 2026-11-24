"""把 25 个保护单元和智图已切分的 64 个模型区块写成同一坐标系的 GIS 文件。"""
import json
from pathlib import Path

import geopandas as gpd
import pandas as pd
from shapely.geometry import Polygon, box

ROOT = Path(r"E:\BaiduSyncdisk\研究生参与项目资料\26-1120铜山古城数字平台")
OUT = ROOT / "单元边界" / "GIS交付"
TILESET = Path(r"H:\tongshan-3dtiles-opt\tileset.blocks.json")
UNITS_4548 = ROOT / "单元边界" / "units_编号_epsg4548.geojson"
UNITS_WGS = ROOT / "platform" / "public" / "data" / "units.geojson"
ORIGIN_X = 553911.59415365779
ORIGIN_Y = 2626595.5488568228
CRS = "EPSG:4548"
GRADE = {1: "一级重点保护", 2: "二级保护协调", 3: "三级一般协调"}


def block_frames():
    data = json.loads(TILESET.read_text(encoding="utf-8"))
    rows = []
    for child in data["root"]["children"]:
        uri = child["content"]["uri"]
        name = uri.split("/")[2]
        cx, cy, _cz, hx, _xhy, _xhz, _yhx, hy, _yhz, *_ = child["boundingVolume"]["box"]
        xmin = ORIGIN_X + cx - hx
        xmax = ORIGIN_X + cx + hx
        ymin = ORIGIN_Y + cy - hy
        ymax = ORIGIN_Y + cy + hy
        rows.append({"block": name, "geometry": box(xmin, ymin, xmax, ymax)})
    return gpd.GeoDataFrame(rows, crs=CRS)


def units():
    raw = json.loads(UNITS_4548.read_text(encoding="utf-8"))
    rows = []
    for feature in raw["features"]:
        ring = feature["geometry"]["coordinates"][0]
        if ring[0] != ring[-1]:
            ring = [*ring, ring[0]]
        geom = Polygon(ring)
        if not geom.is_valid:
            geom = geom.buffer(0)
        rows.append({**feature["properties"], "geometry": geom})
    base = gpd.GeoDataFrame(rows, crs=CRS)
    wgs = json.loads(UNITS_WGS.read_text(encoding="utf-8"))
    attrs = pd.DataFrame([f["properties"] for f in wgs["features"]])[["unit", "name", "area_ha", "grade"]]
    merged = base.drop(columns=[c for c in ("name",) if c in base.columns]).merge(attrs, on="unit", how="left")
    merged["grade"] = merged["grade"].astype(int)
    merged["grade_lbl"] = merged["grade"].map(GRADE)
    merged["area_m2"] = merged.geometry.area.round(1)
    merged["unit"] = merged["unit"].astype(int)
    merged["label"] = merged.apply(lambda r: f"{int(r.unit):02d} {r.grade_lbl}", axis=1)
    return merged.sort_values("unit")


KML_COLOR = {1: "ff2c45d4", 2: "ff3f91c8", 3: "ff5ba07b"}


def write_kml(frame, path: Path):
    parts = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
        "<name>铜山古城保护更新单元</name>",
    ]
    for row in frame.itertuples(index=False):
        geom = row.geometry
        polygons = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
        rings = []
        for poly in polygons:
            rings.append(" ".join(f"{x:.8f},{y:.8f},0" for x, y in poly.exterior.coords))
        color = KML_COLOR.get(int(row.grade), "ffffffff")
        coords = "</coordinates></LinearRing></outerBoundaryIs></Polygon><Polygon><outerBoundaryIs><LinearRing><coordinates>".join(rings)
        parts.append(
            "<Placemark>"
            f"<name>{row.label}</name>"
            f"<description>编号 {int(row.unit):02d}，{row.grade_lbl}，面积 {row.area_ha} 公顷</description>"
            f"<Style><LineStyle><color>{color}</color><width>2</width></LineStyle>"
            "<PolyStyle><color>66ffffff</color></PolyStyle></Style>"
            f"<Polygon><outerBoundaryIs><LinearRing><coordinates>{coords}</coordinates></LinearRing></outerBoundaryIs></Polygon>"
            "</Placemark>"
        )
    parts.append("</Document></kml>")
    path.write_text("\n".join(parts), encoding="utf-8")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    gpkg = OUT / "铜山古城_单元与区块.gpkg"
    if gpkg.exists():
        gpkg.unlink()
    blocks = block_frames()
    zones = units()
    joined = gpd.sjoin(blocks, zones[["unit", "geometry"]], predicate="intersects", how="left")
    rel = (
        joined.dropna(subset=["unit"])
        .assign(unit=lambda d: d["unit"].astype(int))
        [["block", "unit"]]
        .drop_duplicates()
        .sort_values(["block", "unit"])
    )
    block_units = rel.groupby("block")["unit"].apply(lambda s: ",".join(f"{n:02d}" for n in s)).rename("units")
    blocks = blocks.merge(block_units, on="block", how="left")
    blocks["units"] = blocks["units"].fillna("")
    blocks["unit_n"] = blocks["units"].apply(lambda s: 0 if not s else len(s.split(",")))
    zone_blocks = rel.groupby("unit")["block"].apply(lambda s: ",".join(s)).rename("blocks")
    zones = zones.merge(zone_blocks, on="unit", how="left")
    zones["blocks"] = zones["blocks"].fillna("")
    zones["block_n"] = zones["blocks"].apply(lambda s: 0 if not s else len(s.split(",")))

    unit_cols = ["unit", "name", "grade", "grade_lbl", "area_ha", "area_m2", "block_n", "blocks", "label", "geometry"]
    block_cols = ["block", "unit_n", "units", "geometry"]
    zones[unit_cols].to_file(OUT / "铜山古城_单元与区块.gpkg", layer="保护更新单元", driver="GPKG")
    blocks[block_cols].to_file(OUT / "铜山古城_单元与区块.gpkg", layer="模型区块", driver="GPKG", mode="a")

    shp = OUT / "shp"
    shp.mkdir(exist_ok=True)
    zones[unit_cols].drop(columns=["blocks"]).to_file(
        shp / "tongshan_units_4548.shp", driver="ESRI Shapefile", encoding="utf-8"
    )
    blocks[block_cols].to_file(shp / "tongshan_blocks_4548.shp", driver="ESRI Shapefile", encoding="utf-8")
    rel.to_csv(OUT / "区块与单元对照.csv", index=False, encoding="utf-8-sig")

    write_kml(zones.to_crs(4326), OUT / "保护更新单元.kml")

    empty = int((blocks["unit_n"] == 0).sum())
    print(f"units {len(zones)} blocks {len(blocks)} links {len(rel)} blocks_without_unit {empty}")
    print(zones[["unit", "name", "grade_lbl", "block_n"]].to_string(index=False))
    print("bounds units", zones.total_bounds.round(1))
    print("bounds blocks", blocks.total_bounds.round(1))


if __name__ == "__main__":
    main()
