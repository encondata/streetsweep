/** Google's encoded polyline at 6 decimal places (PostGIS ST_AsEncodedPolyline(geom, 6)), as [lng, lat]. */
export function decodePolyline(s: string, precision = 1e6): [number, number][] {
  const out: [number, number][] = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => {
    let result = 0, shift = 0, b: number;
    do {
      b = s.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && i < s.length);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < s.length) {
    lat += next();
    lon += next();
    out.push([lon / precision, lat / precision]);
  }
  return out;
}
