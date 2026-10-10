export const SHIP_MODEL_TYPES = ['passenger', 'cargo', 'tanker', 'tug', 'fishing', 'sailing', 'pleasure', 'generic'] as const;
export type ShipModelType = typeof SHIP_MODEL_TYPES[number];

/** AIS hazard subclasses describe cargo, not a different hull. */
export function shipModelType(type: number | null): ShipModelType {
  if (type !== null && Number.isInteger(type)) {
    if (type >= 60 && type <= 69) return 'passenger';
    if (type >= 70 && type <= 79) return 'cargo';
    if (type >= 80 && type <= 89) return 'tanker';
    if ([31, 32, 52].includes(type)) return 'tug';
    if (type === 30) return 'fishing';
    if (type === 36) return 'sailing';
    if (type === 37) return 'pleasure';
  }
  return 'generic';
}
