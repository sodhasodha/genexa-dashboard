-- USA Domination map (Clients page): where each clinic is.
-- address is what gets geocoded (once, by the Re-geocode button or the import script);
-- lat/lng are the saved result, so the page never geocodes on load.
alter table clients add column address text;
alter table clients add column city text;
alter table clients add column state text;
alter table clients add column lat double precision check (lat is null or (lat between -90 and 90));
alter table clients add column lng double precision check (lng is null or (lng between -180 and 180));
alter table clients add column geocoded_at timestamptz;

-- Hot-pipeline prospects appear on the same map as hollow pins. A prospect only has a state today,
-- so a city can be set from the map and is geocoded the same way.
alter table prospects add column city text;
alter table prospects add column lat double precision check (lat is null or (lat between -90 and 90));
alter table prospects add column lng double precision check (lng is null or (lng between -180 and 180));
