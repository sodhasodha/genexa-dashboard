"""Builds the two static Census files the USA Domination map reads (public/data).

  us-cbsa.json      [name, lat, lng, population (2023 estimate), "M" metro | "u" micro]
                    every US metro / micro area (CBSA), largest first. The centre is the
                    population-weighted centre of its counties (Connecticut: geographic centre,
                    because its 2020 counties were replaced by planning regions).
  us-counties.json  [lat, lng, population (2020 Census), index into us-cbsa.json or -1]
                    each county's centre of population.

Sources (all free, US Census Bureau; Puerto Rico left out):
  https://www2.census.gov/geo/docs/reference/cenpop2020/county/CenPop2020_Mean_CO.txt
  https://www2.census.gov/programs-surveys/popest/datasets/2020-2023/metro/totals/cbsa-est2023-alldata.csv
  https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_cbsa_national.zip

Usage: python3 scripts/build-domination-data.py   (run from genexa-os/)
"""
import csv, io, json, math, urllib.request, zipfile

BASE = "https://www2.census.gov/"
def get(path):
    req = urllib.request.Request(BASE + path, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=120).read()

counties_raw = get("geo/docs/reference/cenpop2020/county/CenPop2020_Mean_CO.txt").decode("utf-8-sig")
cbsa_raw = get("programs-surveys/popest/datasets/2020-2023/metro/totals/cbsa-est2023-alldata.csv").decode("latin-1")
gaz_zip = zipfile.ZipFile(io.BytesIO(get("geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_cbsa_national.zip")))
gaz_raw = gaz_zip.read(gaz_zip.namelist()[0]).decode("latin-1")

cos = {}
for r in csv.DictReader(io.StringIO(counties_raw)):
    if r["STATEFP"] == "72":
        continue
    cos[r["STATEFP"] + r["COUNTYFP"]] = dict(lat=float(r["LATITUDE"]), lng=float(r["LONGITUDE"]), pop=int(r["POPULATION"]), st=r["STATEFP"])

cb, members = {}, {}
for r in csv.DictReader(io.StringIO(cbsa_raw)):
    if r["LSAD"] in ("Metropolitan Statistical Area", "Micropolitan Statistical Area"):
        cb[r["CBSA"]] = dict(name=r["NAME"], pop=int(r["POPESTIMATE2023"]), type="M" if r["LSAD"].startswith("Metro") else "u")
    elif r["LSAD"] == "County or equivalent" and r["STCOU"]:
        members.setdefault(r["CBSA"], []).append(r["STCOU"].zfill(5))

gaz = {}
for i, line in enumerate(gaz_raw.splitlines()):
    if i:
        p = [x.strip() for x in line.split("\t")]
        gaz[p[1]] = (float(p[8]), float(p[9]))

out, idx = [], {}
for code, c in sorted(cb.items(), key=lambda kv: -kv[1]["pop"]):
    if c["name"].endswith(", PR"):
        continue
    ms = [cos[m] for m in members.get(code, []) if m in cos]
    if ms:
        tp = sum(m["pop"] for m in ms)
        lat = sum(m["lat"] * m["pop"] for m in ms) / tp
        lng = sum(m["lng"] * m["pop"] for m in ms) / tp
    elif code in gaz:
        lat, lng = gaz[code]
    else:
        continue
    idx[code] = len(out)
    out.append([c["name"], round(lat, 3), round(lng, 3), c["pop"], c["type"]])

county_cbsa = {m: idx[code] for code, ms in members.items() if code in idx for m in ms}

def miles(a, b, c, d):
    p = math.pi / 180
    x = math.sin((c - a) * p / 2) ** 2 + math.cos(a * p) * math.cos(c * p) * math.sin((d - b) * p / 2) ** 2
    return 2 * 3958.7613 * math.asin(math.sqrt(x))

counties = []
for fips, c in cos.items():
    i = county_cbsa.get(fips, -1)
    if i == -1 and c["st"] == "09":  # Connecticut: nearest CBSA centre
        best = min(range(len(out)), key=lambda k: miles(c["lat"], c["lng"], out[k][1], out[k][2]))
        if miles(c["lat"], c["lng"], out[best][1], out[best][2]) < 35:
            i = best
    counties.append([round(c["lat"], 3), round(c["lng"], 3), c["pop"], i])

json.dump(out, open("public/data/us-cbsa.json", "w"), separators=(",", ":"))
json.dump(counties, open("public/data/us-counties.json", "w"), separators=(",", ":"))
print(f"{len(out)} CBSAs ({sum(1 for o in out if o[3] >= 150000)} of 150k+), {len(counties)} counties, US population {sum(c[2] for c in counties):,}")
