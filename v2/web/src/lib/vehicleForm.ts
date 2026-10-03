import type { Vehicle, VehicleFormValue } from "./types";

export const emptyVehicleForm = (): VehicleFormValue => ({
  name: "", kind: "car", make: "", model: "", year: "", color: "", plate: "", checkout_policy: "open",
});

export const vehicleToForm = (v: Vehicle): VehicleFormValue => ({
  name: v.name, kind: v.kind, make: v.make ?? "", model: v.model ?? "", year: v.year,
  color: v.color ?? "", plate: v.plate ?? "", checkout_policy: v.checkout_policy,
});

/** Blank boxes become nulls so clearing a field clears it on the server. */
export function formToBody(f: VehicleFormValue) {
  const s = (x: string) => x.trim() || null;
  const year = f.year == null ? "" : String(f.year).trim();
  return {
    name: f.name.trim(), kind: f.kind, make: s(f.make), model: s(f.model), color: s(f.color), plate: s(f.plate),
    year: year ? Number(year) : null, checkout_policy: f.checkout_policy,
  };
}
