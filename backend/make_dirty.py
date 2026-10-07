import geopandas as gpd, pandas as pd
g = gpd.read_file("ne_10m_roads.zip")
pd.concat([g, g.head(500)]).to_file("roads_dupes.geojson", driver="GeoJSON")
g.to_crs(3857).head(2000).to_file("roads_webmerc.gpkg", driver="GPKG")
