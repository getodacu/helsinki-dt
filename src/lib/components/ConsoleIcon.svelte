<script lang="ts">
  let { name }: { name: string } = $props();
  const paths: Record<string, string> = {
    imagery: 'M4 5h24v22H4z M4 22l8-9 6 6 4-5 6 8 M23 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
    terrain: 'M3 27L13 6l8 15 4-8 5 14z M9 14l4 3 3-3',
    roads: 'M9 2L5 30 M23 2l4 28 M16 3v5 M16 13v5 M16 23v6',
    explore: 'M4 7l7-3 8 3 7-3v21l-7 3-8-3-7 3z M11 4v21 M19 7v21',
    'traffic-measurement': 'M4 25a13 13 0 1 1 24 0 M6 18h3 M9 8l3 3 M16 4v4 M23 8l-3 3 M23 18h3 M16 22l6-8 M18 22a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
    transport: 'M11 5h10a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H11a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4z M8 16h16 M12 5V2 M20 5V2 M10 29l3-4 M22 29l-3-4 M11 21h2 M19 21h2',
    buildings: 'M5 28V12l12-6v22 M17 13h10v15 M3 28h26 M9 14v3 M13 12v3 M9 20v3 M13 18v3 M21 17v3 M24 17v3 M21 23v3 M24 23v3',
    layers: 'M2 11l14-8 14 8-14 8z M2 17l14 8 14-8 M2 23l14 8 14-8',
    energy: 'M18 2L6 18h9l-1 12 13-18h-10z',
    solar: 'M22 16a6 6 0 1 1-12 0 6 6 0 0 1 12 0 M16 2v4 M16 26v4 M2 16h4 M26 16h4 M6 6l3 3 M23 23l3 3 M6 26l3-3 M23 9l3-3',
    permit: 'M7 3h12l6 6v20H7z M19 3v6h6 M11 14h10 M11 19h10 M11 24h6',
    environment: 'M16 28V15 M16 22l-5-5 M16 18l5-5 M6 17C0 4 20 0 27 4c2 14-8 25-19 17',
    help: 'M28 16a12 12 0 1 1-24 0 12 12 0 0 1 24 0 M12 12c0-5 9-5 9 0 0 4-5 3-5 7 M16 23v1',
    'schedule-on-time': 'M28 16a12 12 0 1 1-24 0 12 12 0 0 1 24 0 M10 16l4 4 8-8',
    'schedule-delayed': 'M28 16a12 12 0 1 1-24 0 12 12 0 0 1 24 0 M16 9v8l5 3',
    'schedule-early': 'M28 16a12 12 0 1 1-24 0 12 12 0 0 1 24 0 M10 16h12 M16 10l6 6-6 6',
    'schedule-unknown': 'M28 16a12 12 0 1 1-24 0 12 12 0 0 1 24 0 M10 16h12',
    inspect: 'M21 14a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M19 19l8 8'
  };
</script>

<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>

<style>
  svg { width: 28px; height: 28px; flex-shrink: 0; }
</style>
