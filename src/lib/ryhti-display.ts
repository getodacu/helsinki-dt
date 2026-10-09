import codeLists from './data/ryhti-codes.json' with { type: 'json' };
import { NO_ENERGY_COLOUR } from './energy-display.ts';
import { ryhtiDate } from './data/ryhti.ts';
import type { RyhtiBuilding, RyhtiCatalog, RyhtiCatalogState } from './ryhti-types.ts';

export const RYHTI_THEMES = [
  { key: 'ryhti:main_purpose', label: 'Use' }, { key: 'ryhti:heating_method', label: 'Heating method' },
  { key: 'ryhti:heating_energy_source', label: 'Heating energy source' }, { key: 'ryhti:permits', label: 'Permit action status' }
] as const;
export const RYHTI_DIM_COLOUR = '#737b80';
const palette = ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#56b4e9', '#d55e00', '#f0e442', '#785ef0', '#dc267f', '#648fff', '#fe6100', '#7a9a01', '#976e48', '#00a6a6', '#b45491', '#8b96a9'];
const labels: Record<string, { label: string; language: string }> = codeLists.labels;
export function ryhtiValue(value: string | number | null): string {
  if (value === null) return 'Unknown';
  if (typeof value === 'number') return String(value);
  if (/^\d{4}-\d{2}-\d{2}Z?$/.test(value)) return ryhtiDate(value);
  if (/^https?:/.test(value)) {
    const item = labels[value];
    return item?.label ?? 'Unknown';
  }
  return value;
}
export function ryhtiForCity(state: RyhtiCatalogState, generatedAt: string | null): RyhtiCatalogState {
  return state.catalog && state.catalog.cityGeneratedAt !== generatedAt
    ? { ...state, status: 'unavailable', catalog: null, message: 'Ryhti snapshot does not match this city generation.' } : state;
}
export function ryhtiCategory(building: RyhtiBuilding, key: string): string {
  if (key === 'ryhti:permits') {
    if (!building.vtjPrt || ['ambiguous', 'conflict'].includes(building.match)) return 'unknown';
    if (!building.permits.length) return 'no-permits';
    const values = new Set(building.permits.map(row => row.properties.status_of_construction_action ?? 'unknown'));
    return values.size > 1 ? 'mixed' : [...values][0];
  }
  const field = key.slice(6);
  if (!['main_purpose', 'heating_method', 'heating_energy_source'].includes(field)) return 'unknown';
  return building.completed?.properties[field as 'main_purpose' | 'heating_method' | 'heating_energy_source'] ?? 'unknown';
}
const categoryLabel = (key: string) => key === 'unknown' ? 'Unknown / no matched value' : key === 'no-permits' ? 'No linked permit records'
  : key === 'mixed' ? 'Multiple statuses' : ryhtiValue(key);
function categoryColour(key: string): string {
  if (key === 'unknown' || key === 'no-permits') return NO_ENERGY_COLOUR;
  if (key === 'mixed') return '#b45491';
  const code = Number(key.split('/').at(-1));
  // Stable code-based colors do not change when a category disappears from a snapshot.
  const index = Number.isSafeInteger(code) ? Math.abs(code - 1) : [...key].reduce((sum, c) => sum + c.charCodeAt(0), 0);
  return palette[index % palette.length];
}
export function ryhtiTheme(catalog: RyhtiCatalog | null, key: string, selectedCategory = '') {
  const colours = new Map<string, string>(), matchingIds = new Set<string>();
  const categories = new Map<string, { key: string; label: string; colour: string; count: number }>();
  if (!catalog || !RYHTI_THEMES.some(theme => theme.key === key)) return { colours, matchingIds, categories: [] };
  for (const building of catalog.buildings) {
    const category = ryhtiCategory(building, key), colour = categoryColour(category), matches = !selectedCategory || category === selectedCategory;
    const entry = categories.get(category) ?? { key: category, label: categoryLabel(category), colour, count: 0 };
    entry.count++; categories.set(category, entry);
    colours.set(building.buildingId, matches ? colour : RYHTI_DIM_COLOUR);
    if (matches) matchingIds.add(building.buildingId);
  }
  return { colours, matchingIds, categories: [...categories.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}
