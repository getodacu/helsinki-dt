<script lang="ts">
  let { name }: { name: string } = $props();
  const paths: Record<string, string> = {
    explore: 'M4 7l7-3 8 3 7-3v21l-7 3-8-3-7 3z M11 4v21 M19 7v21',
    transport: 'M11 5h10a4 4 0 0 1 4 4v12a4 4 0 0 1-4 4H11a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4z M8 16h16 M12 5V2 M20 5V2 M10 29l3-4 M22 29l-3-4 M11 21h2 M19 21h2',
    buildings: 'M5 28V12l12-6v22 M17 13h10v15 M3 28h26 M9 14v3 M13 12v3 M9 20v3 M13 18v3 M21 17v3 M24 17v3 M21 23v3 M24 23v3',
    energy: 'M18 2L6 18h9l-1 12 13-18h-10z',
    environment: 'M16 28V15 M16 22l-5-5 M16 18l5-5 M6 17C0 4 20 0 27 4c2 14-8 25-19 17',
    help: 'M28 16a12 12 0 1 1-24 0 12 12 0 0 1 24 0 M12 12c0-5 9-5 9 0 0 4-5 3-5 7 M16 23v1',
    inspect: 'M21 14a7 7 0 1 1-14 0 7 7 0 0 1 14 0 M19 19l8 8'
  };
</script>

<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>

<style>
  svg { width: 28px; height: 28px; flex-shrink: 0; }
</style>
